export interface PropertyMapping {
  jsonField: string;
  nodeProperty: string;
  include: boolean;
}

export interface NodeDesignConfig {
  nodeLabel: string;
  idField: string;
  propertyMappings: PropertyMapping[];
}

export interface EdgeMappingRule {
  id: string;
  sourceField: string;
  targetNodeLabel: string;
  targetMatchProperty: string;
  edgeLabel: string;
  direction: "out" | "in";
  autoCreateTarget: boolean;
}

export interface DuplicateInfo {
  idValue: string;
  vertexId: string;
}

export interface UploadResult {
  nodesCreated: number;
  nodesSkipped: number;
  nodesUpdated: number;
  edgesCreated: number;
  edgesSkipped: number;
  targetNodesCreated: number;
  errors: string[];
  durationMs: number;
}

export type DuplicateStrategy = "skip" | "update" | "create";

export const EXISTING_NODE_LABELS = [
  "Package",
  "City",
  "Attraction",
  "Hotel",
  "Route",
  "Theme",
  "Region",
  "Airline",
  "Country",
  "Season",
  "Trend",
  "TrendSpot",
];

export const COMMON_EDGE_LABELS = [
  "LOCATED_IN",
  "IN_COUNTRY",
  "IN_REGION",
  "HAS_THEME",
  "VISITS",
  "STAYS_AT",
  "DEPARTS_FROM",
  "ARRIVES_AT",
  "INCLUDES",
  "RELATED_TO",
  "HAS_ATTRACTION",
  "HAS_ROUTE",
  "MENTIONS",
  "NEAR",
  "OPERATED_BY",
  "AVAILABLE_IN",
];

export const FIELD_TO_NODE_HINTS: Record<
  string,
  { nodeLabel: string; matchProp: string; edgeLabel: string }
> = {
  city: { nodeLabel: "City", matchProp: "name", edgeLabel: "LOCATED_IN" },
  country: {
    nodeLabel: "Country",
    matchProp: "name",
    edgeLabel: "IN_COUNTRY",
  },
  region: { nodeLabel: "Region", matchProp: "name", edgeLabel: "IN_REGION" },
  theme: { nodeLabel: "Theme", matchProp: "name", edgeLabel: "HAS_THEME" },
  airline: {
    nodeLabel: "Airline",
    matchProp: "name",
    edgeLabel: "OPERATED_BY",
  },
  hotel: { nodeLabel: "Hotel", matchProp: "name_ko", edgeLabel: "STAYS_AT" },
  season: {
    nodeLabel: "Season",
    matchProp: "name",
    edgeLabel: "AVAILABLE_IN",
  },
  trend: { nodeLabel: "Trend", matchProp: "title", edgeLabel: "RELATED_TO" },
};
