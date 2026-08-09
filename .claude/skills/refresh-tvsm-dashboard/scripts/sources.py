"""Where the pipeline's input frames come from.

`refresh_dashboard.py` used to read its inputs with twenty-one `pd.read_excel` calls
scattered through `main()`, each carrying its own sheet name, header row, `usecols`
window and dtype override. That was fine while `dumps/` was the only source. It stops
being fine the moment the same frames have to come out of Postgres instead, because
those twenty-one specs would then exist twice and drift apart — and a drifted spec here
does not raise, it silently changes a number on the page.

So the specs move into one registry, `SLOTS`, and the pipeline asks a `Sources` object
for a frame by slot name. `ExcelSources` reads `dumps/` exactly as before; a future
`PostgresSources` will serve the same slots from the tables the web uploader writes.
Nothing downstream of the read changes, because both return the same DataFrames.

The registry is deliberately declarative. Adding an input is a row here, not a call site
somewhere in five thousand lines.
"""

from __future__ import annotations

import json
import re
from datetime import time
from dataclasses import dataclass, replace
from pathlib import Path

import pandas as pd


# The schedule workbook fills a month-neutral slot. `july0626_rm_tracker_v1.xlsx` is the
# name it used to have and is still accepted, because a workbook already archived under
# that name must keep loading.
MODEL_FILES = ("rm_tracker_model.xlsx", "july0626_rm_tracker_v1.xlsx")

# The sheet a slot reads is usually fixed. The schedule's is not: it is named for the
# month being published and resolved against the workbook at run time, so its spec says
# "the caller will name it" rather than naming one that would go stale every month.
CALLER_NAMES_THE_SHEET = object()


class SheetMissing(LookupError):
    """The file is present but does not carry the sheet asked for.

    Separate from a missing file because the two mean different things: a missing
    optional file is a dump that was not sent, while a missing sheet in a file that did
    arrive is a workbook that changed shape. `signoff.xlsx` is the one input where a
    missing sheet is routine — its three plants do not all report every week.
    """


@dataclass(frozen=True)
class ReadSpec:
    """One `pd.read_excel` call, stated rather than performed."""

    files: tuple[str, ...]
    sheet: object = 0
    header: int | None = 0
    usecols: str | None = None
    dtype: dict | None = None
    optional: bool = False


def _sales_like(filename: str, *, optional: bool = False) -> ReadSpec:
    """A sales extract: `Sheet1` only, material number as text.

    Both rules are load-bearing. The other sheets in a quarterly extract are working
    copies of `Sheet1`, so reading them double-counts the quarter. And pandas infers a
    float dtype for material codes stored as text and drops their last digit — 3907863
    read as 3907860 on 3,603 of 3,989 rows — which is why `MATERAIL NUMBER` is pinned to
    `str` on every sales file rather than only on the daily dump.
    """
    return ReadSpec((filename,), "Sheet1", 0,
                    dtype={"MATERAIL NUMBER": str}, optional=optional)


SLOTS: dict[str, ReadSpec] = {
    # The governing mapping workbook. Three sheets, three different shapes.
    "bucketting": ReadSpec(MODEL_FILES, "Bucketting", 1, usecols="U:AF"),
    "oem_key": ReadSpec(MODEL_FILES, "OEM_key_1_rev codes", 0, usecols="A:C"),
    "schedule": ReadSpec(MODEL_FILES, CALLER_NAMES_THE_SHEET, 2),
    "schedule_supplement": ReadSpec(("schedule_supplement.xlsx",), optional=True),

    "sales": _sales_like("sales.xlsx"),
    # An optional longer sales window for the code repository. The daily dump is the
    # current month only, too short to see every code a customer has been billed under.
    "sales_history": ReadSpec(("sales_history.xlsx",), 0, 0,
                              dtype={"MATERAIL NUMBER": str}, optional=True),
    # Archived sales driving the past-sales trend. Each closed month is archived this
    # way; the trend takes each month from exactly one source, daily dump winning.
    "sales_q4": _sales_like("sales_q4.xlsx", optional=True),
    "sales_q1": _sales_like("sales_q1.xlsx", optional=True),
    "sales_jul": _sales_like("sales_jul.xlsx", optional=True),

    # `TRANSIT STOCK` is never read off this file — the transit figure comes from the
    # transfer dump, and reading both counts it twice.
    "stock": ReadSpec(("stock.xlsx",), "PLANT STOCKS", 1),
    # The header carries a non-breaking space in `Material No`; the caller replaces it
    # after the read, so the dtype key must carry it too or the pin misses.
    "wip": ReadSpec(("wip.xlsx",), 0, 0, dtype={"Material\xa0No": str}),
    "rfd": ReadSpec(("rfd_4731.xlsx", "rfd.xlsx"), "Sheet5", 1),
    "zmat": ReadSpec(("zmat.xlsx",), "Sheet1", 0),

    "vsm_tvsm": ReadSpec(("rm_tracker_tvsm.xlsx",), "TVSM", 2),
    "vsm_stock": ReadSpec(("rm_tracker_tvsm.xlsx",), "vsm stock", 2),

    "receivables": ReadSpec(("yf65.xlsx",), "Sheet1", 0, optional=True),
    "transfers": ReadSpec(("transfer.xlsx",), 0, 0,
                          dtype={"MATERAIL NUMBER": str}, optional=True),
}

# Files whose sheets are enumerated by a spec dict in the pipeline rather than listed
# one by one here. Each becomes `family:sheet` slots when the Sources object is built,
# so `orders:jsr` and `signoff:hosur` are addressed exactly like any other slot.
SHEET_FAMILIES = {
    "orders": "orders.xlsx",
    "contract": "contract.xlsx",
    "signoff": "signoff.xlsx",
}


def slots_for_families(order_book_sheets, pricing_sheets, signoff_sheets):
    """Expand the three multi-sheet inputs into one slot per sheet.

    The specs live in `refresh_dashboard.py` because the rest of the pipeline reads them
    for their business columns, not just their sheet names. Passing them in keeps that
    single definition and avoids importing the pipeline from its own source layer.
    """
    slots: dict[str, ReadSpec] = {}

    for sheet, spec in order_book_sheets.items():
        # Every candidate code column is read as text, for the same reason sales is.
        # Naming a column the sheet does not have is harmless, which is what lets a
        # spec list alternatives.
        candidates = spec["code_column"]
        candidates = (candidates,) if isinstance(candidates, str) else (candidates or ())
        slots[f"orders:{sheet}"] = ReadSpec(
            ("orders.xlsx",), sheet, spec["header"],
            dtype={column: str for column in candidates} or None, optional=True,
        )

    for route, spec in pricing_sheets.items():
        # Contract sheets are read positionally — the quarters are column offsets — so
        # they are read with no header at all.
        slots[f"contract:{route}"] = ReadSpec(
            ("contract.xlsx",), spec["sheet"], None, optional=True,
        )

    for sheet in signoff_sheets:
        slots[f"signoff:{sheet}"] = ReadSpec(("signoff.xlsx",), sheet, 0, optional=True)

    return slots


class Sources:
    """The frames the pipeline reads, by slot name."""

    def __init__(self, extra_slots: dict[str, ReadSpec] | None = None):
        self.slots = dict(SLOTS)
        if extra_slots:
            self.slots.update(extra_slots)

    def spec(self, slot: str) -> ReadSpec:
        try:
            return self.slots[slot]
        except KeyError:
            raise KeyError(
                f"Unknown input slot {slot!r}. Known slots: {sorted(self.slots)}"
            ) from None

    def available(self, slot: str) -> bool:
        raise NotImplementedError

    def frame(self, slot: str, *, sheet: str | None = None) -> pd.DataFrame:
        raise NotImplementedError

    def sheet_names(self, slot: str) -> list[str]:
        raise NotImplementedError

    def frame_or_empty(self, slot: str, *, sheet: str | None = None) -> pd.DataFrame:
        """An optional input that was not sent reads as an empty frame.

        Several sections are written to cope with an absent dump and say so on the page;
        they test `.empty` rather than branching on a path. Keeping that here means the
        absence is handled the same way whichever backend is serving the slot.
        """
        if not self.available(slot):
            return pd.DataFrame()
        return self.frame(slot, sheet=sheet)


class ExcelSources(Sources):
    """The dumps folder — what the pipeline has always read.

    Every call below is the same `pd.read_excel` the pipeline used to make inline, with
    the same arguments, so this backend is behaviour-neutral by construction. That is
    the point: it is the control against which the Postgres backend is measured.
    """

    def __init__(self, input_dir: Path, extra_slots=None):
        super().__init__(extra_slots)
        self.input_dir = Path(input_dir).resolve()
        self._sheet_name_cache: dict[str, list[str]] = {}

    def path(self, slot: str) -> Path:
        spec = self.spec(slot)
        for name in spec.files:
            candidate = self.input_dir / name
            if candidate.exists():
                return candidate
        if spec.optional:
            raise FileNotFoundError(slot)
        raise FileNotFoundError(
            f"Required input not found. Expected one of: {', '.join(spec.files)}"
        )

    def available(self, slot: str) -> bool:
        try:
            self.path(slot)
        except FileNotFoundError:
            return False
        return True

    def sheet_names(self, slot: str) -> list[str]:
        path = self.path(slot)
        key = str(path)
        if key not in self._sheet_name_cache:
            self._sheet_name_cache[key] = list(pd.ExcelFile(path).sheet_names)
        return self._sheet_name_cache[key]

    def frame(self, slot: str, *, sheet: str | None = None) -> pd.DataFrame:
        spec = self.spec(slot)
        if spec.sheet is CALLER_NAMES_THE_SHEET:
            if sheet is None:
                raise ValueError(f"Slot {slot!r} needs the sheet to be named.")
            spec = replace(spec, sheet=sheet)
        elif sheet is not None:
            spec = replace(spec, sheet=sheet)

        path = self.path(slot)
        try:
            return pd.read_excel(
                path,
                sheet_name=spec.sheet,
                header=spec.header,
                usecols=spec.usecols,
                dtype=spec.dtype,
            )
        except ValueError as exc:
            # pandas raises ValueError for a sheet the workbook does not carry. Naming
            # that case is what lets the caller tell it apart from a genuinely broken
            # read; checking the sheet list up front would mean opening every workbook
            # twice, and zmat alone is 6.9 MB.
            if "Worksheet" in str(exc) or "sheet" in str(exc).lower():
                raise SheetMissing(f"{path.name} has no sheet {spec.sheet!r}") from exc
            raise


def excel_column_range(usecols: str | None, width: int) -> list[int]:
    """The column positions a `usecols` window selects, e.g. "U:AF" -> 20..31.

    Only the letter-range form is supported, because it is the only form the pipeline
    uses. A name list would be a different thing and is deliberately not guessed at.
    """
    if usecols is None:
        return list(range(width))
    if not re.fullmatch(r"[A-Z]+:[A-Z]+", usecols):
        raise ValueError(f"Unsupported usecols spec {usecols!r}")

    def index_of(letters: str) -> int:
        n = 0
        for char in letters:
            n = n * 26 + (ord(char) - ord("A") + 1)
        return n - 1

    first, last = usecols.split(":")
    return list(range(index_of(first), index_of(last) + 1))


def name_columns(header_cells: list, count: int) -> list[str]:
    """Header names the way pandas makes them: blanks numbered, duplicates suffixed.

    Reproduced rather than approximated, because a column named differently here is a
    KeyError three thousand lines later — or worse, a silently absent column that a
    `.get` turns into an empty series.
    """
    names: list[str] = []
    for position in range(count):
        value = header_cells[position] if position < len(header_cells) else None
        if value is None or (isinstance(value, str) and value == ""):
            names.append(f"Unnamed: {position}")
        elif isinstance(value, float) and value.is_integer():
            # A header cell holding a number reads as the number, not as "3.0".
            names.append(str(int(value)))
        else:
            names.append(str(value))

    seen: dict[str, int] = {}
    mangled: list[str] = []
    for name in names:
        if name in seen:
            seen[name] += 1
            mangled.append(f"{name}.{seen[name]}")
        else:
            seen[name] = 0
            mangled.append(name)
    return mangled


class CellSources(Sources):
    """Frames rebuilt from a parsed cell grid rather than read from a workbook.

    This is the shape the uploaded dumps take: the browser parses the .xlsx and stores
    the sheet as cells, and the read spec — which row is the header, which column window,
    which columns are pinned to text — is applied here, at read time. Keeping the spec on
    this side means a corrected header row is a re-read, not a re-upload.

    It is also the thing under test. `tools/compare_cell_sources.py` asserts that every
    slot rebuilt this way equals the one `pd.read_excel` produces, which is the whole
    basis for trusting an uploaded dump as much as a mailed file.
    """

    def __init__(self, cell_dir: Path, extra_slots=None):
        super().__init__(extra_slots)
        self.cell_dir = Path(cell_dir)

    def _path(self, slot: str) -> Path:
        return self.cell_dir / f"{slot.replace(':', '__')}.json"

    def available(self, slot: str) -> bool:
        self.spec(slot)
        return self._path(slot).exists()

    def sheet_names(self, slot: str) -> list[str]:
        # Only the schedule asks, and it asks which months are held. Each stored grid
        # names the sheet it came from, so the answer is the sheets that were uploaded.
        return sorted({
            json.loads(path.read_text())["sheet"]
            for path in self.cell_dir.glob(f"{slot.replace(':', '__')}*.json")
        })

    def frame(self, slot: str, *, sheet: str | None = None) -> pd.DataFrame:
        spec = self.spec(slot)
        path = self._path(slot)
        if not path.exists():
            raise FileNotFoundError(f"No stored cells for slot {slot!r}")
        stored = json.loads(path.read_text())
        if sheet is not None and stored["sheet"] != sheet:
            raise SheetMissing(f"stored cells for {slot!r} are sheet {stored['sheet']!r}")

        grid = [
            [self._decode(cell) for cell in row]
            for row in stored["cells"]
        ]

        # Bound the sheet on its content before anything else, because openpyxl does:
        # the declared range routinely runs past the last real row. Crucially this looks
        # at the whole row, not the column window — Bucketting is read as U:AF, and 211
        # of its rows are blank in that window while carrying data elsewhere. Trimming
        # after the window dropped all 211.
        last_row = None
        for index, row in enumerate(grid):
            if any(cell is not None for cell in row):
                last_row = index
        grid = grid[: 0 if last_row is None else last_row + 1]

        width = stored["n_cols"]
        keep = [c for c in excel_column_range(spec.usecols, width) if c < width]

        if spec.header is None:
            body = grid
            names = list(range(len(keep)))
        else:
            header_row = grid[spec.header] if spec.header < len(grid) else []
            names = name_columns([header_row[c] for c in keep], len(keep))
            body = grid[spec.header + 1:]

        rows = [[row[c] if c < len(row) else None for c in keep] for row in body]
        frame = pd.DataFrame(rows, columns=names)

        # A trailing column that is empty top to bottom, header included, is the same
        # artefact one axis over. Only unnamed ones go: a named column that happens to be
        # empty this week is part of the sheet's shape and pandas keeps it.
        if spec.header is not None:
            while len(frame.columns):
                last = frame.columns[-1]
                if str(last).startswith("Unnamed: ") and frame[last].isna().all():
                    frame = frame.iloc[:, :-1]
                else:
                    break

        for column in frame.columns:
            frame[column] = self._as_pandas_dtype(frame[column], column, spec)
        return frame.reset_index(drop=True)

    @staticmethod
    def _decode(cell):
        if isinstance(cell, dict):
            if "__excel_date" in cell:
                return pd.Timestamp(cell["__excel_date"]).tz_localize(None)
            if "__excel_time" in cell:
                return time.fromisoformat(cell["__excel_time"])
        return cell

    @staticmethod
    def _as_pandas_dtype(series: pd.Series, column, spec: ReadSpec) -> pd.Series:
        """Give a rebuilt column the dtype `read_excel` would have given it.

        A column built from a Python list is object dtype whatever it holds, so the
        numeric and datetime columns have to be recovered. The pinned text columns are
        left alone on purpose — pinning them is what stops a material code losing its
        last digit to a float.
        """
        if spec.dtype and column in spec.dtype:
            return series.astype(object).map(
                lambda v: None if v is None or (isinstance(v, float) and pd.isna(v)) else str(v)
            )

        values = series.dropna()
        if values.empty:
            return series.astype(object)
        if all(isinstance(v, pd.Timestamp) for v in values):
            return pd.to_datetime(series)
        if all(isinstance(v, bool) for v in values):
            return series.astype(bool) if len(values) == len(series) else series
        if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in values):
            numeric = pd.to_numeric(series, errors="coerce")
            # pandas keeps an all-integer column as int64 only when nothing is missing.
            if len(values) == len(series) and all(float(v).is_integer() for v in values):
                return numeric.astype("int64")
            return numeric.astype("float64")
        return series.astype(object)
