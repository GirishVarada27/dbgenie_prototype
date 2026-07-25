import { NavLink } from "react-router-dom"

const NAV_ITEMS = [
  { to: "/databases", label: "Databases" },
  { to: "/health", label: "Health" },
  { to: "/chat", label: "AI Chat" },
  { to: "/sql-optimizer", label: "SQL Optimizer" },
]

export default function Sidebar() {
  return (
    <aside className="w-56 shrink-0 border-r border-slate-200 bg-white px-3 py-4">
      <div className="px-3 pb-6 text-lg font-semibold text-indigo-600">DBGenie AI</div>
      <nav className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `rounded-md px-3 py-2 text-sm font-medium ${
                isActive ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100"
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}
