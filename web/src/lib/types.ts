// ─── Planning Input ───

export interface Duration {
  nights: number;
  days: number;
}

export interface PlanningInput {
  destination: string;
  duration: Duration;
  departure_season: string;
  similarity_level: number;
  reference_product_id?: string;
  /** Theme.key (companion + interest groups) — v3 Theme vertex keys */
  themes: string[];
  /** v3 Brand vertex name: "세이브" (쇼핑 포함) | "스탠다드" (쇼핑 미포함) */
  brand?: string;
  natural_language_request?: string;
  target_customer?: string;
  meal_preference?: string;
  hotel_grade?: string;
  input_mode: "chat" | "form";
}

// ─── Planning Output (Hanatour-compatible format) ───

export interface FlightDetail {
  date: string;
  day_of_week: string;
  departure_time: string;
  arrival_time: string;
  flight_number: string;
  duration: string;
}

export interface Pricing {
  currency: string;
  adult_price: number;
  child_price: number;
  infant_price: number;
  fuel_surcharge: number;
  single_room_surcharge: number;
}

export interface GuideFee {
  amount: number;
  currency: string;
}

export interface DayItinerary {
  day: number;
  date: string;
  day_of_week: string;
  cities: string;
  attractions: string[];
}

export interface Attraction {
  name: string;
  short_description: string;
}

export interface CostItem {
  category: string;
  detail: string;
}

export interface Insurance {
  coverage_amount: string;
  medical_limit: string;
  baggage_limit: string;
}

export interface MeetingInfo {
  datetime: string;
  location: string;
}

export interface BookingPolicy {
  deposit_per_person: number;
  deposit_deadline: string;
  cancellation_policy: string;
}

export interface DestinationCity {
  name: string;
  code: string;
  timezone?: string | null;
  voltage: string;
  frequency: string;
}

export interface GraphTraceQuery {
  cypher: string;
  params: Record<string, unknown>;
  rows: number;
  latency_ms: number;
}

export interface GraphTraceCall {
  tool: string;
  arguments: Record<string, unknown>;
  source: "live" | "cache" | "agent_cache" | "error";
  latency_ms: number;
  queries: GraphTraceQuery[];
  error?: string;
}

export interface ChangesSummary {
  retained: string[];
  modified: string[];
  similarity_applied: number;
  layers_modified: string[];
  /** Deprecated — kept optional for backward compatibility with old DDB items. */
  trend_added?: string[];
}

export interface PlanningOutput {
  // Hanatour core fields
  product_code: string;
  package_name: string;
  description: string;
  hashtags: string[];
  rating: number;
  review_count: number;

  nights: number;
  days: number;
  duration: string;

  airline: string;
  airline_type: string;

  departure_flight: FlightDetail;
  return_flight: FlightDetail;

  travel_cities: string;
  city_list: string[];

  pricing: Pricing;

  /** v3 Brand vertex name: "세이브" (쇼핑 포함) | "스탠다드" (쇼핑 미포함) */
  brand?: string;
  /** Deprecated — replaced by `brand`. Optional for backward compat. */
  shopping_count?: number;
  guide_fee: GuideFee;
  product_line: string;

  highlights: string[];
  hotels: string[];

  itinerary: DayItinerary[];
  attractions: Attraction[];

  inclusions: CostItem[];
  exclusions: CostItem[];
  optional_costs: CostItem[];

  insurance: Insurance;
  meeting_info: MeetingInfo;
  booking_policy: BookingPolicy;

  destination_cities: DestinationCity[];

  source_url: string;
  travel_agency: string;
  country: string;
  region: string;

  // Agent meta fields
  similarity_score: number;
  /** Layer-weighted Jaccard between this output and the reference (0..100). */
  achieved_similarity?: number;
  /** Per-layer Jaccard percentages (route/hotel/attraction). */
  similarity_breakdown?: { route?: number; hotel?: number; attraction?: number };
  reference_products: string[];
  changes_summary: ChangesSummary;
  /** Knowledge Graph 도구 호출 트레이스 */
  graph_trace?: GraphTraceCall[];
  /** Deprecated — kept optional for backward compatibility. */
  trend_sources?: string[];
  generated_at: string;
  generated_by: string;
  planning_started_at?: string;
  planning_finished_at?: string;
  planning_elapsed_seconds?: number;
}

// ─── Chat Payload ───

export interface ChatPayload {
  mode: "chat";
  message: string;
  history: Array<{ role: string; content: string }>;
}

// ─── SSE Events ───

export type PlanningEventType =
  | "progress"
  | "result"
  | "error"
  | "message_chunk"
  | "message_complete"
  | "tool_use"
  | "validation";

export interface ProgressData {
  step: string;
  percent: number;
  message?: string;
}

export interface PlanningEvent {
  event: PlanningEventType;
  data: ProgressData | PlanningOutput | { message: string };
}

// ─── Graph Entities ───

export interface PackageNode {
  code: string;
  name: string;
  description?: string;
  price: number;
  child_price?: number;
  infant_price?: number;
  nights: number;
  days: number;
  rating: number;
  review_count?: number;
  season: string[];
  product_line?: string;
  hashtags: string[];
  shopping_count?: number;
  has_escort?: boolean;
  guide_fee?: GuideFee;
  meal_included?: string;
  optional_tour?: boolean;
  single_room_surcharge?: number;
  deposit_per_person?: number;
  source_url?: string;
  travel_cities?: string;
  /** v3 Brand: "세이브" (쇼핑 포함) | "스탠다드" (쇼핑 미포함) */
  brand?: string;
}

export interface CityNode {
  name: string;
  country: string;
  region: string;
  code?: string;
  timezone?: string;
  voltage?: string;
  size?: string;
}

export interface AttractionNode {
  name: string;
  category: string;
  description?: string;
  family_friendly?: boolean;
  photo_worthy?: boolean;
}

export interface HotelNode {
  name_ko: string;
  name_en: string;
  grade: string;
  room_type?: string;
  has_onsen?: boolean;
  amenities?: string;
  description?: string;
}

export interface RouteNode {
  id: string;
  departure_city: string;
  arrival_city: string;
  airline: string;
  airline_type: string;
  flight_number: string;
  departure_time: string;
  arrival_time: string;
  duration: string;
}

export interface TrendNode {
  id: string;
  title: string;
  type: string;
  source: string;
  date: string;
  virality_score: number;
  decay_rate: number;
  keywords?: string[];
  tier?: "hot" | "steady" | "seasonal";
}

export interface TrendSpotNode {
  name: string;
  description: string;
  category: string;
  lat?: number;
  lng?: number;
  photo_worthy?: boolean;
}

// ─── Graph Visualization ───

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface GraphLink {
  id: string;
  source: string;
  target: string;
  label: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  stats: Record<string, number>;
}

// v3 스키마 (15 정점) — SCHEMA_REFERENCE.md 기준
export const NODE_TYPE_COLORS: Record<string, string> = {
  // 마스터
  Country: "#2ea597",
  City: "#d91515",
  // 상품
  Brand: "#9c5fff",
  RepresentativeProduct: "#0972d3",
  SaleProduct: "#1f78b4",
  // 항공
  Airline: "#656871",
  Airport: "#414d5c",
  FlightSegment: "#8456ce",
  // 숙박
  HotelStay: "#c33d69",
  Hotel: "#df3312",
  // 명소
  Attraction: "#037f0c",
  // 추천 신호
  Theme: "#e07941",
  Season: "#b8860b",
  // 트렌드 placeholder (A6 — 추천 weight 미사용)
  HotTrend: "#fd8d3c",
  SteadyTrend: "#5b9bd5",
};

// v3 정점 라벨 메타데이터 (SCHEMA_REFERENCE.md §1)
export const V3_VERTEX_INFO: Record<
  string,
  { count: number; description: string; idPattern: string }
> = {
  Country: {
    count: 2,
    description: "마스터 그대로",
    idPattern: "Country:{code}",
  },
  City: {
    count: 524,
    description: "마스터 그대로 (운영 모집단은 4 도시: OSA/UKY/UKB/ARN)",
    idPattern: "City:{code}",
  },
  Brand: {
    count: 2,
    description: "세이브(쇼핑 포함) / 스탠다드(쇼핑 미포함)",
    idPattern: "Brand:{name}",
  },
  Airline: {
    count: 12,
    description: "package_airport.airlCd distinct",
    idPattern: "Airline:{airlineCode}",
  },
  Airport: {
    count: 39,
    description: "package_airport_city + package_airport 조인",
    idPattern: "Airport:{airportCode}",
  },
  RepresentativeProduct: {
    count: 62,
    description: "package_product_meta.rprsProdCd distinct",
    idPattern: "RepresentativeProduct:{rprsProdCd}",
  },
  SaleProduct: {
    count: 76,
    description: "package_product_meta 전체",
    idPattern: "SaleProduct:{saleProdCd}",
  },
  FlightSegment: {
    count: 152,
    description: "76 SaleProduct × 2 segments",
    idPattern: "FlightSegment:{saleProdCd}:{segReq}",
  },
  HotelStay: {
    count: 364,
    description: "package_hotel_stay 전체",
    idPattern: "HotelStay:{saleProdCd}:{schdDay}:{htlCd}",
  },
  Attraction: {
    count: 1053,
    description: "간사이 ∧ 비-교통 ∧ useYn=Y (A1)",
    idPattern: "Attraction:{LJP_id}",
  },
  Hotel: {
    count: 4389,
    description: "JP ∧ 간사이 4 도시 (A2)",
    idPattern: "Hotel:{packageHotelId}",
  },
  Theme: {
    count: 10,
    description: "themes 메타 시드 (5 companion + 5 interest)",
    idPattern: "Theme:{key}",
  },
  Season: {
    count: 4,
    description: "seasons 메타 시드 (Q1~Q4)",
    idPattern: "Season:{key}",
  },
  HotTrend: {
    count: 1,
    description: "default placeholder (A6) — 분류기 도입 전",
    idPattern: "HotTrend:{period}:{slug}",
  },
  SteadyTrend: {
    count: 1,
    description: "default placeholder (A6)",
    idPattern: "SteadyTrend:{slug}",
  },
};

// v3 엣지 라벨 메타데이터 (SCHEMA_REFERENCE.md §2 — 20 종)
export const V3_EDGE_INFO: ReadonlyArray<{
  label: string;
  count: number;
  direction: string;
  weighted?: boolean;
}> = [
  { label: "IN_COUNTRY", count: 5966, direction: "City|Hotel|Attraction → Country" },
  { label: "IN_CITY", count: 5442, direction: "Hotel|Attraction → City" },
  { label: "OPERATED_BY", count: 152, direction: "FlightSegment → Airline" },
  { label: "INSTANCE_OF", count: 76, direction: "SaleProduct → RepresentativeProduct" },
  { label: "HAS_BRAND", count: 76, direction: "SaleProduct → Brand" },
  { label: "ARRIVES_IN", count: 76, direction: "SaleProduct → City" },
  { label: "VISITS_CITY", count: 218, direction: "SaleProduct → City" },
  { label: "HAS_FLIGHT_SEGMENT", count: 152, direction: "SaleProduct → FlightSegment" },
  { label: "DEPARTS_FROM_AIRPORT", count: 152, direction: "FlightSegment → Airport" },
  { label: "ARRIVES_AT_AIRPORT", count: 152, direction: "FlightSegment → Airport" },
  { label: "HAS_HOTEL_STAY", count: 364, direction: "SaleProduct → HotelStay" },
  { label: "MATCHED_TO", count: 172, direction: "HotelStay → Hotel" },
  { label: "HAS_SCHEDULED_ATTRACTION", count: 252, direction: "SaleProduct → Attraction" },
  { label: "IN_THEME", count: 10490, direction: "Attraction → Theme", weighted: true },
  { label: "BEST_IN_SEASON", count: 4196, direction: "Attraction → Season", weighted: true },
  { label: "IN_HOT_TREND", count: 1053, direction: "Attraction → HotTrend", weighted: true },
  { label: "IN_STEADY_TREND", count: 1053, direction: "Attraction → SteadyTrend", weighted: true },
  { label: "TRAVEL_TO", count: 47, direction: "Attraction → Attraction", weighted: true },
  { label: "ARRIVAL_FIRST_VISIT", count: 10, direction: "Airport → Attraction", weighted: true },
  { label: "DEPARTURE_LAST_VISIT", count: 9, direction: "Attraction → Airport", weighted: true },
];

// ─── Chat ───

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

// ─── Constants ───

// ─── 간사이 4도시 (v3 운영 모집단: OSA / UKY / UKB / ARN) ─────────────────
//
// v3 그래프 데이터는 간사이 4개 도시로만 모집단이 한정됩니다. 다른 지역은
// 추천 데이터가 없으므로 UI에서 노출하지 않습니다.

export const REGIONS = [
  { value: "일본", label: "일본" },
] as const;

export const KANSAI_CITIES = [
  { value: "오사카", code: "OSA", label: "오사카 (Osaka)" },
  { value: "교토", code: "UKY", label: "교토 (Kyoto)" },
  { value: "고베", code: "UKB", label: "고베 (Kobe)" },
  { value: "나라", code: "ARN", label: "나라 (Nara)" },
] as const;

export const SUB_REGIONS: Record<string, Array<{ value: string; label: string }>> = {
  "일본": KANSAI_CITIES.map(({ value, label }) => ({ value, label })),
};

export const SEASONS = [
  { value: "봄", label: "봄 (3~5월)" },
  { value: "여름", label: "여름 (6~8월)" },
  { value: "가을", label: "가을 (9~11월)" },
  { value: "겨울", label: "겨울 (12~2월)" },
] as const;

// ─── 테마 (v3 Theme 정점 — companion 5 + interest 5) ───────────────────────

export const THEMES_COMPANION = [
  { value: "FAMILY_WITH_KIDS", label: "가족여행" },
  { value: "WITH_PARENTS", label: "부모님동행" },
  { value: "ROMANTIC_COUPLE", label: "로맨틱커플" },
  { value: "FRIENDS", label: "친구여행" },
  { value: "SOLO_HEALING", label: "혼자힐링" },
] as const;

export const THEMES_INTEREST = [
  { value: "FOODIE", label: "미식" },
  { value: "HISTORY_CULTURE", label: "역사문화" },
  { value: "NATURE_SCENERY", label: "자연풍경" },
  { value: "SHOPPING", label: "쇼핑" },
  { value: "ACTIVITY_EXPERIENCE", label: "체험액티비티" },
] as const;

// ─── 브랜드 (v3 Brand 정점 — 쇼핑 포함 여부 결정) ─────────────────────────
// 세이브: 쇼핑 포함  /  스탠다드: 쇼핑 미포함

export const BRANDS = [
  { value: "세이브", label: "세이브 (쇼핑 포함)" },
  { value: "스탠다드", label: "스탠다드 (쇼핑 미포함)" },
] as const;

export const MEAL_OPTIONS = [
  { value: "전식 포함", label: "전식 포함" },
  { value: "중식 포함", label: "중식 포함" },
  { value: "조식만 포함", label: "조식만 포함" },
  { value: "자유식", label: "자유식" },
] as const;

export const HOTEL_GRADES = [
  { value: "비즈니스", label: "비즈니스" },
  { value: "3성급", label: "3성급" },
  { value: "5성급", label: "5성급" },
  { value: "료칸", label: "료칸" },
] as const;

export const LAYER_LABELS: Record<string, string> = {
  route: "L1: 노선/도시",
  hotel: "L2: 숙박",
  attraction: "L3: 핵심 관광지",
  activity: "L4: 세부 액티비티",
  theme: "L5: 분위기/테마",
};
