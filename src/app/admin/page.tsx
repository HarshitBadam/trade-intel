import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/guard";
import { AdminForm } from "./AdminForm";

// Server-side gate: only allowlisted admins (or local dev) may even render the
// form. The postCompany action enforces the same check again as a backstop.
export default async function AdminPage() {
  if (!(await isAdmin())) {
    redirect("/");
  }
  return <AdminForm />;
}
