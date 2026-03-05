import AppLayout from "@/components/layout/AppLayout";
import PackageTable from "@/components/packages/PackageTable";

export default function PackagesRoute() {
  return (
    <AppLayout contentType="table">
      <PackageTable />
    </AppLayout>
  );
}
