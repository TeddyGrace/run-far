import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, RequireAuth, useAuth } from "./lib/auth.js";
import { Layout } from "./components/Layout.js";
import { Login } from "./pages/Login.js";
import { Signup } from "./pages/Signup.js";
import { VerifyEmail } from "./pages/VerifyEmail.js";
import { ForgotPassword } from "./pages/ForgotPassword.js";
import { ResetPassword } from "./pages/ResetPassword.js";
import { Privacy } from "./pages/Privacy.js";
import { Terms } from "./pages/Terms.js";
import { Refund } from "./pages/Refund.js";
import { Home } from "./pages/Home.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Calendar } from "./pages/Calendar.js";
import { Build } from "./pages/Build.js";
import { Settings } from "./pages/Settings.js";

// Every signed-in screen — the dashboard at "/" included — renders through this one `Layout`
// element. Keeping the dashboard in the same subtree as the other tabs is what lets React
// reuse the `Layout` instance across navigations: give "/" a `Layout` of its own and switching
// tabs unmounts one and mounts the other, which tears down and rebuilds the coach panel.
function AuthedApp() {
  const { user, isLoading } = useAuth();
  const { pathname } = useLocation();

  // "/" has to be reachable without signing in — Google's OAuth branding review requires the
  // app's home page to describe the app to a signed-out visitor. Signed-in athletes get the
  // dashboard there instead, so the landing page is only what anonymous visitors (and
  // crawlers) see. It also stands in while the session check is in flight: a crawler that
  // executes JS snapshots the page before /api/me resolves, so a spinner here is all Google's
  // branding verifier would ever see. Every other path defers to RequireAuth below, which
  // sends signed-out visitors to /login.
  if (pathname === "/" && (isLoading || !user)) {
    return <Home />;
  }

  return (
    <RequireAuth>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/build" element={<Build />} />
          <Route path="/import" element={<Navigate to="/build" replace />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </Layout>
    </RequireAuth>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/refunds" element={<Refund />} />
        <Route path="/*" element={<AuthedApp />} />
      </Routes>
    </AuthProvider>
  );
}
