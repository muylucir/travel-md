import AppLayout from "@/components/layout/AppLayout";
import SchemaManager from "@/components/graph-schema/SchemaManager";

export default function SchemasPage() {
  return (
    <AppLayout contentType="table">
      <SchemaManager />
    </AppLayout>
  );
}
