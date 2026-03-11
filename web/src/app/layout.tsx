import type { Metadata } from "next";
import "@cloudscape-design/global-styles/index.css";

export const metadata: Metadata = {
  title: "여행 상품 기획 AI - Travel MD Agent",
  description:
    "Knowledge Graph 기반 여행 패키지 상품 기획 지원 에이전트",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
