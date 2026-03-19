"use client";

import { usePathname, useRouter } from "next/navigation";
import SideNavigation from "@cloudscape-design/components/side-navigation";

export default function Navigation() {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <SideNavigation
      header={{ text: "여행 상품 기획 AI", href: "/" }}
      activeHref={pathname}
      onFollow={(event) => {
        event.preventDefault();
        router.push(event.detail.href);
      }}
      items={[
        {
          type: "section",
          text: "기획",
          items: [
            {
              type: "link",
              text: "상품 기획",
              href: "/planning",
            },
            {
              type: "link",
              text: "기획 상품",
              href: "/products",
            },
          ],
        },
        {
          type: "section",
          text: "데이터",
          items: [
            {
              type: "link",
              text: "패키지 브라우저",
              href: "/packages",
            },
            {
              type: "link",
              text: "트렌드 관리",
              href: "/trends",
            },
            {
              type: "link",
              text: "그래프 탐색기",
              href: "/graph",
            },
            {
              type: "link",
              text: "그래프 업로드",
              href: "/graph/upload",
            },
          ],
        },
      ]}
    />
  );
}
