import { Suspense } from "react";
import LoginForm from "./form";

// The form reads ?next= to send you back where you were headed, and useSearchParams has
// to sit inside a Suspense boundary or the page cannot be prerendered at all.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
