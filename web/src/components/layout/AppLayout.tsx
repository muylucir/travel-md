"use client";

import { useState } from "react";
import CloudscapeAppLayout from "@cloudscape-design/components/app-layout";
import TopNavigation from "@cloudscape-design/components/top-navigation";
import Navigation from "./Navigation";

interface AppLayoutProps {
  children: React.ReactNode;
  contentType?: "default" | "table" | "form" | "wizard" | "cards";
}

export default function AppLayout({
  children,
  contentType = "default",
}: AppLayoutProps) {
  const [navigationOpen, setNavigationOpen] = useState(true);

  return (
    <>
      <div id="top-nav">
        <TopNavigation
          identity={{
            href: "/",
            title: "여행상품 기획 에이전트",
          }}
          utilities={[
            {
              type: "button",
              text: "도움말",
              href: "#",
              external: false,
            },
          ]}
        />
      </div>
      <CloudscapeAppLayout
        navigation={<Navigation />}
        navigationOpen={navigationOpen}
        onNavigationChange={({ detail }) =>
          setNavigationOpen(detail.open)
        }
        content={children}
        contentType={contentType}
        toolsHide
        headerSelector="#top-nav"
      />
    </>
  );
}
