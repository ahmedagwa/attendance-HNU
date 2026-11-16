import { requirePage } from "@/lib/auth";
import { ScannerFlow } from "@/components/student/scanner-flow";

export const metadata = { title: "Scan attendance" };

export default async function Scan() {
  await requirePage("student");
  return <ScannerFlow />;
}
