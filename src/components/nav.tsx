import Link from "next/link"

export function MainNav() {
  return (
    <div className="flex w-full px-4 shadow-md">
      <div className="flex w-full max-w-8xl mx-auto justify-between items-center">
        <div className="flex items-center">
          <Link href="/" className="flex items-center">
            <span className="inline-block font-extrabold p-4">TRADEINTEL</span>
          </Link>
        </div>

        <div className="flex gap-13 p-4">
          <Link
            href="/"
            className="flex items-center text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Stocks
          </Link>
         
          <Link
            href="/login" 
            className="flex items-center text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Login
          </Link>
        </div>
      </div>
    </div>
  )
} 