import { Navigate, Route, Routes } from "react-router-dom"
import RequireAuth from "./components/RequireAuth"
import EnsureOrganization from "./components/EnsureOrganization"
import DashboardLayout from "./components/DashboardLayout"
import Login from "./pages/Login"
import Signup from "./pages/Signup"
import MfaEnroll from "./pages/MfaEnroll"
import Databases from "./pages/Databases"
import Health from "./pages/Health"
import AiChat from "./pages/AiChat"
import SqlOptimizer from "./pages/SqlOptimizer"
import NotFound from "./pages/NotFound"

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />

      <Route
        path="/mfa/enroll"
        element={
          <RequireAuth>
            <MfaEnroll />
          </RequireAuth>
        }
      />

      <Route
        element={
          <RequireAuth>
            <EnsureOrganization>
              <DashboardLayout />
            </EnsureOrganization>
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/databases" replace />} />
        <Route path="/databases" element={<Databases />} />
        <Route path="/health" element={<Health />} />
        <Route path="/chat" element={<AiChat />} />
        <Route path="/sql-optimizer" element={<SqlOptimizer />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
