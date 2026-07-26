import { NavLink } from "react-router-dom"
import { ChatIcon, DatabasesIcon, HealthIcon, IncidentsIcon, SqlIcon } from "./NavIcons"

const NAV_ITEMS = [
  { to: "/databases", label: "Databases", Icon: DatabasesIcon },
  { to: "/health", label: "Health", Icon: HealthIcon },
  { to: "/chat", label: "AI Chat", Icon: ChatIcon },
  { to: "/sql-optimizer", label: "SQL Optimizer", Icon: SqlIcon },
  { to: "/incidents", label: "Incidents", Icon: IncidentsIcon },
]

export default function Sidebar() {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
      <div className="px-5 py-5 font-display text-base font-semibold tracking-tight text-text-primary">
        DBGenie <span className="text-accent">AI</span>
      </div>
      <nav className="flex flex-col gap-0.5 px-2">
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive ? "text-text-primary" : "text-text-secondary hover:text-text-primary"
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={`absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent transition-opacity ${
                    isActive ? "opacity-100" : "opacity-0"
                  }`}
                />
                <Icon className="h-4 w-4 shrink-0" />
                <span className="font-medium">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}
