#!/usr/bin/env python3
"""Create, remove and re-grant dashboard accounts in access.json.

Accounts and their tab grants live in the published `access.json`, not in the page, so
adding someone is a change to one file and needs no rebuild. Passwords are never
stored: only sha256("username:salt:password"), salted per user so two people sharing a
password do not share a digest.

    python3 manage_users.py --access access.json list
    python3 manage_users.py --access access.json add mes2 --password s3cret \
        --tabs meghView pricingView
    python3 manage_users.py --access access.json grant mes --tabs meghView
    python3 manage_users.py --access access.json remove mes2

This is a gate, not access control: everything the browser needs to check a password
travels to the browser, and `data.json` carries every tab's figures whatever the grant
says. See SKILL.md.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def digest(username: str, salt: str, password: str) -> str:
    return hashlib.sha256(f"{username}:{salt}:{password}".encode()).hexdigest()


def load(path: Path) -> dict:
    if not path.is_file():
        raise SystemExit(f"{path} does not exist; run the refresh once to create it.")
    return json.loads(path.read_text(encoding="utf-8"))


def save(path: Path, access: dict) -> None:
    path.write_text(json.dumps(access, indent=2) + "\n", encoding="utf-8")


def known_views(access: dict) -> list[str]:
    return [tab["view"] for tab in access.get("tabs", [])]


def check_views(access: dict, views: list[str]) -> None:
    unknown = [v for v in views if v not in known_views(access)]
    if unknown:
        raise SystemExit(
            f"unknown tab(s) {unknown}; choose from {known_views(access)}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--access", type=Path, default=Path("access.json"))
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list")
    add = sub.add_parser("add")
    add.add_argument("username")
    add.add_argument("--password", required=True)
    add.add_argument("--tabs", nargs="*", default=[])
    grant = sub.add_parser("grant")
    grant.add_argument("username")
    grant.add_argument("--tabs", nargs="*", default=[])
    remove = sub.add_parser("remove")
    remove.add_argument("username")
    args = parser.parse_args()

    access = load(args.access)
    access.setdefault("accounts", {})
    access.setdefault("visible", {})
    admin = access.get("admin", "apoorv")
    salt = access.get("salt")
    if not salt:
        raise SystemExit("access.json carries no salt; a refresh will add one.")

    if args.command == "list":
        for username in sorted(access["accounts"]):
            if username == admin:
                print(f"{username:16s} admin — every tab")
                continue
            granted = access["visible"].get(username)
            if granted is None:
                print(f"{username:16s} every tab (no grant recorded)")
            elif granted:
                print(f"{username:16s} {', '.join(granted)}")
            else:
                print(f"{username:16s} no tabs")
        return

    username = args.username.strip().lower()
    if args.command == "add":
        if username in access["accounts"]:
            raise SystemExit(f"{username} already exists; use grant to change its tabs.")
        check_views(access, args.tabs)
        access["accounts"][username] = digest(username, salt, args.password)
        if username != admin:
            # Order the grant the way the tabs are ordered, so the file reads like the
            # tab row rather than in the order the arguments happened to arrive.
            access["visible"][username] = [
                v for v in known_views(access) if v in set(args.tabs)
            ]
        save(args.access, access)
        print(f"added {username} with {len(args.tabs)} tab(s)")
        return

    if args.command == "grant":
        if username not in access["accounts"]:
            raise SystemExit(f"{username} does not exist; add it first.")
        if username == admin:
            raise SystemExit("the admin account always sees every tab.")
        check_views(access, args.tabs)
        access["visible"][username] = [
            v for v in known_views(access) if v in set(args.tabs)
        ]
        save(args.access, access)
        print(f"{username} now sees {len(args.tabs)} tab(s)")
        return

    if args.command == "remove":
        if username == admin:
            raise SystemExit("refusing to remove the admin account.")
        access["accounts"].pop(username, None)
        access["visible"].pop(username, None)
        save(args.access, access)
        print(f"removed {username}")


if __name__ == "__main__":
    main()
