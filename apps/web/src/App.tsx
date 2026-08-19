import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAuth, useAuth } from "./lib/auth.js";
import { Layout } from "./components/Layout.js";
import { Login } from "./pages/Login.js";
import { Signup } from "./pages/Signup.js";
import { VerifyEmail } from "./pages/VerifyEmail.js";
import { ForgotPassword } from "./pages/ForgotPassword.js";
import { ResetPassword } from "./pages/ResetPassword.js";
import { Privacy } from "./pages/Privacy.js";
import { Home } from "./pages/Home.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Calendar } from "./pages/Calendar.js";
import { Build } from "./pages/Build.js";
import { Settings } from "./pages/Settings.js";

// "/" has to be reachable without signing in — Google's OAuth branding review requires the
// app's home page to describe the app to a signed-out visitor. Signed-in athletes still get
// the dashboard there, so the landing page is only what anonymous visitors (and crawlers) see.
function HomeRoute() {
  const { user, isLoading } = useAuth();

  // Render the landing page while the session check is in flight. A crawler that executes JS
  // snapshots the page before /api/me resolves, so a spinner here is all Google's branding
  // verifier would ever see.
  if (isLoading || !user) {
    return <Home />;
  }
  return (
    <Layout>
      <Dashboard />
    </Layout>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<HomeRoute />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <Layout>
                <Routes>
                  <Route path="/calendar" element={<Calendar />} />
                  <Route path="/build" element={<Build />} />
                  <Route path="/import" element={<Navigate to="/build" replace />} />
                  <Route path="/settings" element={<Settings />} />
                </Routes>
              </Layout>
            </RequireAuth>
          }
        />
      </Routes>
    </AuthProvider>
  );
}
