/**
 * 매핑 룰 문서 ↔ NodeDesignConfig / EdgeMappingRule 변환.
 *
 * 사용자가 JSON으로 정의한 매핑 룰 문서를
 * 기존 그래프 업로드 파이프라인이 이해하는 내부 타입으로 변환한다.
 */

import type {
  NodeDesignConfig,
  EdgeMappingRule,
  DuplicateStrategy,
} from "@/components/graph-upload/types";

// ─── 매핑 룰 문서 타입 ───

export interface MappingRuleProperty {
  from: string;
  type: "string" | "number" | "boolean" | "json";
}

export interface MappingRuleEdge {
  label: string;
  direction: "out" | "in";
  source_field: string;
  target: {
    label: string;
    match_by: string;
    auto_create: boolean;
  };
}

export interface MappingRuleDocument {
  name: string;
  description?: string;
  source_vertex: {
    label: string;
    id_field: string;
    properties: Record<string, MappingRuleProperty>;
  };
  edges: MappingRuleEdge[];
  options?: {
    duplicate_strategy?: DuplicateStrategy;
    batch_size?: number;
  };
}

// ─── 중첩 필드 해석 (dot notation) ───

/**
 * dot notation 경로로 중첩 객체의 값을 가져온다.
 *
 *   resolveField({ pricing: { adult_price: 599900 } }, "pricing.adult_price")
 *   // → 599900
 */
function resolveField(obj: Record<string, unknown>, path: string): unknown {
  if (!path.includes(".")) return obj[path];
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object")
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * 매핑 룰의 from / source_field 에 dot notation이 있으면
 * 원본 중첩 JSON을 플랫 레코드로 변환한다.
 *
 * 기존 업로드 파이프라인(PreviewStep, neptune-csv 등)은
 * item[field] 형태의 플랫 접근만 지원하므로,
 * 이 함수로 한 번 변환해서 넘기면 나머지는 그대로 동작한다.
 */
export function flattenData(
  data: Record<string, unknown>[],
  rule: MappingRuleDocument
): Record<string, unknown>[] {
  // dot notation이 하나도 없으면 변환 불필요
  const allPaths = [
    rule.source_vertex.id_field,
    ...Object.values(rule.source_vertex.properties).map((p) => p.from),
    ...rule.edges.map((e) => e.source_field),
  ];
  const hasDot = allPaths.some((p) => p.includes("."));
  if (!hasDot) return data;

  return data.map((item) => {
    const flat: Record<string, unknown> = {};

    // 1. ID 필드
    flat[rule.source_vertex.id_field] = resolveField(
      item,
      rule.source_vertex.id_field
    );

    // 2. Properties — dot notation 경로를 플랫 키로 매핑
    //    from: "pricing.adult_price" → flat["pricing.adult_price"] = 599900
    for (const prop of Object.values(rule.source_vertex.properties)) {
      flat[prop.from] = resolveField(item, prop.from);
    }

    // 3. Edge source fields
    for (const edge of rule.edges) {
      if (!(edge.source_field in flat)) {
        flat[edge.source_field] = resolveField(item, edge.source_field);
      }
    }

    // 4. 원본 top-level 필드 보존 (미리보기에서 나머지 필드도 보여주기 위함)
    for (const key of Object.keys(item)) {
      if (!(key in flat)) {
        flat[key] = item[key];
      }
    }

    return flat;
  });
}

// ─── 변환 ───

export function convertMappingRule(
  rule: MappingRuleDocument,
  dataFields: string[]
): {
  nodeDesign: NodeDesignConfig;
  edgeMappings: EdgeMappingRule[];
  duplicateStrategy: DuplicateStrategy;
} {
  // 1. PropertyMapping 생성
  const mappedJsonFields = new Set<string>();
  const propertyMappings = Object.entries(rule.source_vertex.properties).map(
    ([nodeProperty, prop]) => {
      mappedJsonFields.add(prop.from);
      return { jsonField: prop.from, nodeProperty, include: true };
    }
  );

  // id_field도 mapped로 표시
  mappedJsonFields.add(rule.source_vertex.id_field);

  // 데이터 필드 중 매핑되지 않은 필드는 include: false로 추가 (PreviewStep 호환)
  for (const field of dataFields) {
    if (!mappedJsonFields.has(field)) {
      propertyMappings.push({
        jsonField: field,
        nodeProperty: field,
        include: false,
      });
    }
  }

  const nodeDesign: NodeDesignConfig = {
    nodeLabel: rule.source_vertex.label,
    idField: rule.source_vertex.id_field,
    propertyMappings,
  };

  // 2. EdgeMappingRule 생성
  const edgeMappings: EdgeMappingRule[] = rule.edges.map((edge, i) => ({
    id: `edge-${i}`,
    sourceField: edge.source_field,
    targetNodeLabel: edge.target.label,
    targetMatchProperty: edge.target.match_by,
    edgeLabel: edge.label,
    direction: edge.direction,
    autoCreateTarget: edge.target.auto_create,
  }));

  const duplicateStrategy: DuplicateStrategy =
    rule.options?.duplicate_strategy || "skip";

  return { nodeDesign, edgeMappings, duplicateStrategy };
}

// ─── 검증 ───

export function validateMappingRule(raw: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["매핑 룰이 JSON 객체가 아닙니다."] };
  }

  const rule = raw as Record<string, unknown>;

  // name
  if (!rule.name || typeof rule.name !== "string") {
    errors.push('"name" 필드가 필요합니다. (문자열)');
  }

  // source_vertex
  if (!rule.source_vertex || typeof rule.source_vertex !== "object") {
    errors.push('"source_vertex" 객체가 필요합니다.');
    return { valid: false, errors };
  }

  const sv = rule.source_vertex as Record<string, unknown>;

  if (!sv.label || typeof sv.label !== "string") {
    errors.push('"source_vertex.label" 필드가 필요합니다. (문자열)');
  }
  if (!sv.id_field || typeof sv.id_field !== "string") {
    errors.push('"source_vertex.id_field" 필드가 필요합니다. (문자열)');
  }
  if (!sv.properties || typeof sv.properties !== "object") {
    errors.push('"source_vertex.properties" 객체가 필요합니다.');
  } else {
    const props = sv.properties as Record<string, unknown>;
    for (const [key, val] of Object.entries(props)) {
      if (!val || typeof val !== "object") {
        errors.push(
          `"source_vertex.properties.${key}"는 { from, type } 객체여야 합니다.`
        );
        continue;
      }
      const prop = val as Record<string, unknown>;
      if (!prop.from || typeof prop.from !== "string") {
        errors.push(
          `"source_vertex.properties.${key}.from" 필드가 필요합니다.`
        );
      }
      if (
        !prop.type ||
        !["string", "number", "boolean", "json"].includes(prop.type as string)
      ) {
        errors.push(
          `"source_vertex.properties.${key}.type"은 string/number/boolean/json 중 하나여야 합니다.`
        );
      }
    }
  }

  // edges
  if (!Array.isArray(rule.edges)) {
    errors.push('"edges" 배열이 필요합니다.');
  } else {
    for (let i = 0; i < rule.edges.length; i++) {
      const edge = rule.edges[i] as Record<string, unknown>;
      const prefix = `"edges[${i}]"`;
      if (!edge.label || typeof edge.label !== "string") {
        errors.push(`${prefix}.label 필드가 필요합니다.`);
      }
      if (!["out", "in"].includes(edge.direction as string)) {
        errors.push(`${prefix}.direction은 "out" 또는 "in"이어야 합니다.`);
      }
      if (!edge.source_field || typeof edge.source_field !== "string") {
        errors.push(`${prefix}.source_field 필드가 필요합니다.`);
      }
      if (!edge.target || typeof edge.target !== "object") {
        errors.push(`${prefix}.target 객체가 필요합니다.`);
      } else {
        const target = edge.target as Record<string, unknown>;
        if (!target.label || typeof target.label !== "string") {
          errors.push(`${prefix}.target.label 필드가 필요합니다.`);
        }
        if (!target.match_by || typeof target.match_by !== "string") {
          errors.push(`${prefix}.target.match_by 필드가 필요합니다.`);
        }
        if (typeof target.auto_create !== "boolean") {
          errors.push(`${prefix}.target.auto_create은 boolean이어야 합니다.`);
        }
      }
    }
  }

  // options (선택)
  if (rule.options !== undefined) {
    if (typeof rule.options !== "object") {
      errors.push('"options"는 객체여야 합니다.');
    } else {
      const opts = rule.options as Record<string, unknown>;
      if (
        opts.duplicate_strategy !== undefined &&
        !["skip", "update", "create"].includes(
          opts.duplicate_strategy as string
        )
      ) {
        errors.push(
          '"options.duplicate_strategy"는 skip/update/create 중 하나여야 합니다.'
        );
      }
      if (
        opts.batch_size !== undefined &&
        (typeof opts.batch_size !== "number" || opts.batch_size < 1)
      ) {
        errors.push('"options.batch_size"는 1 이상의 숫자여야 합니다.');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── 기본 템플릿 ───

export function getDefaultMappingRule(): string {
  return JSON.stringify(
    {
      name: "example-mapping",
      description: "RDBMS 테이블 → Graph 변환 예시",
      source_vertex: {
        label: "Restaurant",
        id_field: "restaurant_id",
        properties: {
          name: { from: "name", type: "string" },
          cuisine: { from: "cuisine_type", type: "string" },
          rating: { from: "avg_rating", type: "number" },
        },
      },
      edges: [
        {
          label: "LOCATED_IN",
          direction: "out",
          source_field: "city_name",
          target: {
            label: "City",
            match_by: "name",
            auto_create: false,
          },
        },
      ],
      options: {
        duplicate_strategy: "update",
        batch_size: 100,
      },
    },
    null,
    2
  );
}
