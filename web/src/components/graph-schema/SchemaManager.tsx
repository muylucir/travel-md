"use client";

import { useState, useEffect, useCallback } from "react";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import Button from "@cloudscape-design/components/button";
import Box from "@cloudscape-design/components/box";
import Badge from "@cloudscape-design/components/badge";
import Alert from "@cloudscape-design/components/alert";
import Modal from "@cloudscape-design/components/modal";
import Link from "@cloudscape-design/components/link";
import SchemaEditor from "./SchemaEditor";
import type { GraphSchema } from "@/components/graph-upload/types";

type Mode = "list" | "create" | "edit";

export default function SchemaManager() {
  const [schemas, setSchemas] = useState<GraphSchema[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("list");
  const [editingSchema, setEditingSchema] = useState<GraphSchema | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GraphSchema | null>(null);
  const [selectedItems, setSelectedItems] = useState<GraphSchema[]>([]);

  const fetchSchemas = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/graph/schemas");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSchemas(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "스키마 목록을 불러올 수 없습니다."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSchemas();
  }, [fetchSchemas]);

  const handleCreate = useCallback(
    async (schema: Omit<GraphSchema, "schemaId" | "createdAt" | "updatedAt">) => {
      setSaving(true);
      try {
        const res = await fetch("/api/graph/schemas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(schema),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setMode("list");
        await fetchSchemas();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "스키마 생성에 실패했습니다."
        );
      } finally {
        setSaving(false);
      }
    },
    [fetchSchemas]
  );

  const handleUpdate = useCallback(
    async (schema: Omit<GraphSchema, "schemaId" | "createdAt" | "updatedAt">) => {
      if (!editingSchema) return;
      setSaving(true);
      try {
        const res = await fetch(
          `/api/graph/schemas/${editingSchema.schemaId}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(schema),
          }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setMode("list");
        setEditingSchema(null);
        await fetchSchemas();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "스키마 수정에 실패했습니다."
        );
      } finally {
        setSaving(false);
      }
    },
    [editingSchema, fetchSchemas]
  );

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(
        `/api/graph/schemas/${deleteTarget.schemaId}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDeleteTarget(null);
      await fetchSchemas();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "스키마 삭제에 실패했습니다."
      );
    }
  }, [deleteTarget, fetchSchemas]);

  if (mode === "create") {
    return (
      <SpaceBetween size="l">
        <Header variant="h1">새 스키마 생성</Header>
        <SchemaEditor
          onSave={handleCreate}
          onCancel={() => setMode("list")}
          saving={saving}
        />
      </SpaceBetween>
    );
  }

  if (mode === "edit" && editingSchema) {
    return (
      <SpaceBetween size="l">
        <Header variant="h1">스키마 수정 — {editingSchema.name}</Header>
        <SchemaEditor
          initial={editingSchema}
          onSave={handleUpdate}
          onCancel={() => {
            setMode("list");
            setEditingSchema(null);
          }}
          saving={saving}
        />
      </SpaceBetween>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="그래프 데이터 업로드 시 사용할 스키마 템플릿을 관리합니다."
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={fetchSchemas} iconName="refresh" loading={loading}>
              새로고침
            </Button>
            <Button variant="primary" onClick={() => setMode("create")}>
              스키마 생성
            </Button>
          </SpaceBetween>
        }
      >
        그래프 스키마 관리
      </Header>

      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Table
        items={schemas}
        loading={loading}
        loadingText="스키마를 불러오는 중..."
        selectionType="single"
        selectedItems={selectedItems}
        onSelectionChange={({ detail }) =>
          setSelectedItems(detail.selectedItems as GraphSchema[])
        }
        empty={
          <Box textAlign="center" padding="xxl">
            <SpaceBetween size="m">
              <Box variant="h3" color="inherit">
                등록된 스키마가 없습니다
              </Box>
              <Box color="text-body-secondary">
                &quot;스키마 생성&quot; 버튼을 클릭하여 첫 번째 스키마를
                만들어보세요.
              </Box>
              <Button onClick={() => setMode("create")}>스키마 생성</Button>
            </SpaceBetween>
          </Box>
        }
        columnDefinitions={[
          {
            id: "name",
            header: "스키마 이름",
            cell: (item) => (
              <Link
                onFollow={(e) => {
                  e.preventDefault();
                  setEditingSchema(item);
                  setMode("edit");
                }}
              >
                {item.name}
              </Link>
            ),
            sortingField: "name",
            width: 200,
          },
          {
            id: "nodeLabel",
            header: "노드 타입",
            cell: (item) => <Badge color="blue">{item.nodeLabel}</Badge>,
            width: 140,
          },
          {
            id: "idField",
            header: "ID 필드",
            cell: (item) => <Box variant="code">{item.idField}</Box>,
            width: 120,
          },
          {
            id: "properties",
            header: "속성",
            cell: (item) => `${item.properties.length}개`,
            width: 80,
          },
          {
            id: "edges",
            header: "엣지",
            cell: (item) => `${item.edges.length}개`,
            width: 80,
          },
          {
            id: "updatedAt",
            header: "수정일",
            cell: (item) =>
              new Date(item.updatedAt).toLocaleDateString("ko-KR"),
            sortingField: "updatedAt",
            width: 120,
          },
          {
            id: "actions",
            header: "작업",
            cell: (item) => (
              <SpaceBetween direction="horizontal" size="xxs">
                <Button
                  variant="inline-link"
                  onClick={() => {
                    setEditingSchema(item);
                    setMode("edit");
                  }}
                >
                  편집
                </Button>
                <Button
                  variant="inline-link"
                  onClick={() => setDeleteTarget(item)}
                >
                  삭제
                </Button>
              </SpaceBetween>
            ),
            width: 140,
          },
        ]}
        header={
          <Header counter={`(${schemas.length})`}>스키마 목록</Header>
        }
        variant="full-page"
        stripedRows
        stickyHeader
      />

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <Modal
          visible
          onDismiss={() => setDeleteTarget(null)}
          header="스키마 삭제"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setDeleteTarget(null)}>
                  취소
                </Button>
                <Button variant="primary" onClick={handleDelete}>
                  삭제
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <Box>
            <strong>{deleteTarget.name}</strong> ({deleteTarget.nodeLabel})
            스키마를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.
          </Box>
        </Modal>
      )}
    </SpaceBetween>
  );
}
