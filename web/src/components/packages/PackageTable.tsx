"use client";

import { useState, useEffect } from "react";
import Table from "@cloudscape-design/components/table";
import Header from "@cloudscape-design/components/header";
import Pagination from "@cloudscape-design/components/pagination";
import TextFilter from "@cloudscape-design/components/text-filter";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Select from "@cloudscape-design/components/select";
import { useCollection } from "@cloudscape-design/collection-hooks";
import { usePackages } from "@/hooks/usePackages";
import { SEASONS } from "@/lib/types";
import type { PackageNode } from "@/lib/types";
import PackageDetail from "./PackageDetail";

export default function PackageTable() {
  const { packages, loading, error, refresh } = usePackages();
  const [selectedPackage, setSelectedPackage] = useState<PackageNode | null>(
    null
  );
  const [detailVisible, setDetailVisible] = useState(false);
  const [destinationFilter, setDestinationFilter] = useState<string>("");
  const [seasonFilter, setSeasonFilter] = useState<string>("");
  const [regions, setRegions] = useState<{ value: string; label: string }[]>([]);

  useEffect(() => {
    fetch("/api/graph/regions")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setRegions(
            data.map((r: { name: string }) => ({ value: r.name, label: r.name }))
          );
        }
      })
      .catch(() => {});
  }, []);

  const {
    items,
    filterProps,
    paginationProps,
    collectionProps,
  } = useCollection(packages, {
    filtering: {
      empty: (
        <Box textAlign="center" color="inherit">
          <b>패키지가 없습니다</b>
          <Box padding={{ bottom: "s" }} variant="p" color="inherit">
            검색 조건을 변경해보세요.
          </Box>
        </Box>
      ),
      noMatch: (
        <Box textAlign="center" color="inherit">
          <b>일치하는 패키지가 없습니다</b>
          <Box padding={{ bottom: "s" }} variant="p" color="inherit">
            필터를 조정해보세요.
          </Box>
        </Box>
      ),
    },
    pagination: { pageSize: 15 },
    sorting: {
      defaultState: {
        sortingColumn: { sortingField: "rating" },
        isDescending: true,
      },
    },
  });

  const handleRefresh = () => {
    const filters: Record<string, string | number> = {};
    if (destinationFilter) filters.destination = destinationFilter;
    if (seasonFilter) filters.season = seasonFilter;
    refresh(filters);
  };

  const handleRowClick = (pkg: PackageNode) => {
    setSelectedPackage(pkg);
    setDetailVisible(true);
  };

  return (
    <>
      <Table
        {...collectionProps}
        header={
          <Header
            variant="h1"
            counter={`(${packages.length})`}
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Select
                  selectedOption={
                    destinationFilter
                      ? {
                          value: destinationFilter,
                          label:
                            regions.find(
                              (d) => d.value === destinationFilter
                            )?.label || destinationFilter,
                        }
                      : { value: "", label: "전체 목적지" }
                  }
                  onChange={({ detail }) =>
                    setDestinationFilter(detail.selectedOption.value || "")
                  }
                  options={[
                    { value: "", label: "전체 목적지" },
                    ...regions,
                  ]}
                />
                <Select
                  selectedOption={
                    seasonFilter
                      ? {
                          value: seasonFilter,
                          label:
                            SEASONS.find((s) => s.value === seasonFilter)
                              ?.label || seasonFilter,
                        }
                      : { value: "", label: "전체 시즌" }
                  }
                  onChange={({ detail }) =>
                    setSeasonFilter(detail.selectedOption.value || "")
                  }
                  options={[
                    { value: "", label: "전체 시즌" },
                    ...SEASONS.map((s) => ({
                      value: s.value,
                      label: s.label,
                    })),
                  ]}
                />
                <Button onClick={handleRefresh} iconName="refresh">
                  조회
                </Button>
              </SpaceBetween>
            }
          >
            패키지 브라우저
          </Header>
        }
        columnDefinitions={[
          {
            id: "code",
            header: "상품 코드",
            cell: (item) => (
              <Button
                variant="link"
                onClick={() => handleRowClick(item)}
              >
                {item.code}
              </Button>
            ),
            sortingField: "code",
            width: 180,
          },
          {
            id: "name",
            header: "상품명",
            cell: (item) => item.name,
            sortingField: "name",
            width: 300,
          },
          {
            id: "nights",
            header: "일정",
            cell: (item) => `${item.nights}박 ${item.days}일`,
            sortingField: "nights",
            width: 90,
          },
          {
            id: "price",
            header: "가격",
            cell: (item) =>
              item.price ? `${item.price.toLocaleString()}원` : "-",
            sortingField: "price",
            width: 120,
          },
          {
            id: "rating",
            header: "평점",
            cell: (item) => (item.rating ? `${item.rating}` : "-"),
            sortingField: "rating",
            width: 70,
          },
          {
            id: "season",
            header: "시즌",
            cell: (item) =>
              item.season?.length
                ? item.season.map((s, i) => (
                    <Badge key={i} color="blue">
                      {s}
                    </Badge>
                  ))
                : "-",
            width: 120,
          },
          {
            id: "hashtags",
            header: "테마/태그",
            cell: (item) =>
              item.hashtags?.slice(0, 3).map((h, i) => (
                <Badge key={i} color="grey">
                  {h}
                </Badge>
              )) || "-",
            width: 200,
          },
        ]}
        items={items}
        loading={loading}
        loadingText="패키지 목록을 불러오는 중..."
        filter={
          <TextFilter
            {...filterProps}
            filteringPlaceholder="상품명으로 검색..."
          />
        }
        pagination={<Pagination {...paginationProps} />}
        variant="full-page"
        stickyHeader
        stripedRows
      />

      {detailVisible && selectedPackage && (
        <PackageDetail
          packageCode={selectedPackage.code}
          packageName={selectedPackage.name}
          visible={detailVisible}
          onDismiss={() => setDetailVisible(false)}
        />
      )}

      {error && (
        <Box textAlign="center" color="text-status-error" padding="l">
          오류: {error}
        </Box>
      )}
    </>
  );
}
