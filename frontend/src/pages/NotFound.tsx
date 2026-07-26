import { Link } from "react-router-dom"

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-background font-sans">
      <h1 className="font-display text-2xl font-semibold text-text-primary">Page not found</h1>
      <Link to="/" className="text-accent hover:underline">
        Back to dashboard
      </Link>
    </div>
  )
}
