"use client";

import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Box from "@cloudscape-design/components/box";
import type { DayItinerary } from "@/lib/types";

interface ItineraryCardProps {
  itinerary: DayItinerary;
}

export default function ItineraryCard({ itinerary }: ItineraryCardProps) {
  const { day, date, day_of_week, cities, attractions } = itinerary;

  const dateLabel = date ? `${date} (${day_of_week})` : "";

  return (
    <Container
      header={
        <Header variant="h3">
          Day {day}{" "}
          {dateLabel && (
            <Box
              variant="span"
              color="text-body-secondary"
              fontSize="body-s"
            >
              {dateLabel}
            </Box>
          )}
          {" "}
          <Box variant="span" color="text-body-secondary" fontSize="body-s">
            {cities}
          </Box>
        </Header>
      }
    >
      <SpaceBetween size="s">
        {attractions.length > 0 ? (
          <div>
            <Box variant="awsui-key-label">관광지 / 활동</Box>
            <SpaceBetween size="xs" direction="horizontal">
              {attractions.map((name, idx) => (
                <div
                  key={idx}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "4px 10px",
                    borderRadius: 6,
                    backgroundColor: "#f2f3f3",
                    border: "1px solid #e9ebed",
                    fontSize: 13,
                  }}
                >
                  {name}
                </div>
              ))}
            </SpaceBetween>
          </div>
        ) : (
          <Box variant="p" color="text-body-secondary">
            이동일 (관광 일정 없음)
          </Box>
        )}
      </SpaceBetween>
    </Container>
  );
}
