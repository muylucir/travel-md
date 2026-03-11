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
  themes: string[];
  natural_language_request?: string;
  target_customer?: string;
  max_budget_per_person?: number;
  max_shopping_count?: number;
  meal_preference?: string;
  hotel_grade?: string;
  trend_mix?: { hot: number; steady: number };
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

export interface ChangesSummary {
  retained: string[];
  modified: string[];
  trend_added: string[];
  similarity_applied: number;
  layers_modified: string[];
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

  shopping_count: number;
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
  reference_products: string[];
  changes_summary: ChangesSummary;
  trend_sources: string[];
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

export const NODE_TYPE_COLORS: Record<string, string> = {
  Package: "#0972d3",
  Attraction: "#037f0c",
  City: "#d91515",
  Route: "#8456ce",
  Theme: "#e07941",
  Region: "#067f68",
  Airline: "#656871",
  Hotel: "#c33d69",
  Country: "#2ea597",
  Season: "#b8860b",
  Trend: "#e6550d",
  TrendSpot: "#fd8d3c",
};

// ─── Chat ───

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

// ─── Constants ───

export const REGIONS = [
  { value: "일본", label: "일본" },
  { value: "동남아시아", label: "동남아시아" },
  { value: "유럽", label: "유럽" },
  { value: "미주", label: "미주" },
  { value: "중국/대만/홍콩", label: "중국/대만/홍콩" },
  { value: "대양주", label: "대양주" },
] as const;

export const SUB_REGIONS: Record<string, Array<{ value: string; label: string }>> = {
  "일본": [
    { value: "오사카", label: "오사카 / 간사이" },
    { value: "규슈", label: "규슈" },
    { value: "도쿄", label: "도쿄 / 간토" },
    { value: "홋카이도", label: "홋카이도" },
    { value: "오키나와", label: "오키나와" },
    { value: "나고야", label: "나고야 / 중부" },
  ],
  "동남아시아": [
    { value: "다낭", label: "다낭" },
    { value: "방콕", label: "방콕" },
    { value: "세부", label: "세부" },
    { value: "발리", label: "발리" },
    { value: "하노이", label: "하노이" },
    { value: "싱가포르", label: "싱가포르" },
  ],
  "유럽": [
    { value: "파리", label: "파리" },
    { value: "로마", label: "로마 / 이탈리아" },
    { value: "바르셀로나", label: "바르셀로나 / 스페인" },
    { value: "런던", label: "런던" },
    { value: "스위스", label: "스위스" },
    { value: "동유럽", label: "동유럽" },
  ],
  "미주": [
    { value: "하와이", label: "하와이" },
    { value: "뉴욕", label: "뉴욕" },
    { value: "LA", label: "LA / 서부" },
    { value: "캐나다", label: "캐나다" },
    { value: "멕시코", label: "멕시코 / 칸쿤" },
  ],
  "중국/대만/홍콩": [
    { value: "대만", label: "대만" },
    { value: "홍콩", label: "홍콩/마카오" },
    { value: "상하이", label: "상하이" },
    { value: "베이징", label: "베이징" },
  ],
  "대양주": [
    { value: "시드니", label: "시드니" },
    { value: "괌", label: "괌" },
    { value: "사이판", label: "사이판" },
    { value: "뉴질랜드", label: "뉴질랜드" },
  ],
};

export const SEASONS = [
  { value: "봄", label: "봄 (3~5월)" },
  { value: "여름", label: "여름 (6~8월)" },
  { value: "가을", label: "가을 (9~11월)" },
  { value: "겨울", label: "겨울 (12~2월)" },
] as const;

export const THEMES = [
  { value: "가족여행", label: "가족여행" },
  { value: "힐링", label: "힐링" },
  { value: "온천", label: "온천" },
  { value: "허니문", label: "허니문" },
  { value: "식도락", label: "식도락" },
  { value: "쇼핑", label: "쇼핑" },
  { value: "액티비티", label: "액티비티" },
  { value: "문화탐방", label: "문화탐방" },
  { value: "자연/트레킹", label: "자연/트레킹" },
  { value: "효도여행", label: "효도여행" },
  { value: "졸업여행", label: "졸업여행" },
  { value: "우정여행", label: "우정여행" },
  { value: "혼행(나홀로)", label: "혼행(나홀로)" },
  { value: "시즌이벤트", label: "시즌이벤트" },
] as const;

export const SHOPPING_OPTIONS = [
  { value: "-1", label: "제한없음" },
  { value: "0", label: "0회 (쇼핑 없음)" },
  { value: "1", label: "1회" },
  { value: "2", label: "2회" },
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
