"use client";

import ResultPanel from "@/components/planning/ResultPanel";
import type { PlanningOutput } from "@/lib/types";

interface ProductDetailProps {
  product: PlanningOutput;
}

export default function ProductDetail({ product }: ProductDetailProps) {
  return <ResultPanel result={product} />;
}
