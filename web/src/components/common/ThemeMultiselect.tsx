"use client";

import Multiselect from "@cloudscape-design/components/multiselect";
import FormField from "@cloudscape-design/components/form-field";

const THEME_CATEGORIES = [
  {
    label: "여행 스타일",
    options: [
      { value: "가족여행", label: "가족여행" },
      { value: "허니문", label: "허니문" },
      { value: "효도여행", label: "효도여행" },
      { value: "졸업여행", label: "졸업여행" },
      { value: "우정여행", label: "우정여행" },
      { value: "혼행(나홀로)", label: "혼행(나홀로)" },
    ],
  },
  {
    label: "테마",
    options: [
      { value: "힐링", label: "힐링" },
      { value: "온천", label: "온천" },
      { value: "식도락", label: "식도락" },
      { value: "쇼핑", label: "쇼핑" },
      { value: "액티비티", label: "액티비티" },
    ],
  },
  {
    label: "관심사",
    options: [
      { value: "문화탐방", label: "문화탐방" },
      { value: "자연/트레킹", label: "자연/트레킹" },
      { value: "시즌이벤트", label: "시즌이벤트" },
    ],
  },
];

interface ThemeMultiselectProps {
  selectedThemes: string[];
  onChange: (themes: string[]) => void;
  disabled?: boolean;
}

export default function ThemeMultiselect({
  selectedThemes,
  onChange,
  disabled,
}: ThemeMultiselectProps) {
  return (
    <FormField
      label="테마 선택"
      description="하나 이상의 테마를 선택하세요. 카테고리별로 그룹화되어 있습니다."
    >
      <Multiselect
        selectedOptions={selectedThemes.map((t) => ({
          value: t,
          label: t,
        }))}
        onChange={({ detail }) =>
          onChange(
            detail.selectedOptions
              .map((o) => o.value)
              .filter((v): v is string => v !== undefined)
          )
        }
        options={THEME_CATEGORIES.map((cat) => ({
          label: cat.label,
          options: cat.options,
        }))}
        placeholder="테마를 선택하세요"
        tokenLimit={5}
        disabled={disabled}
      />
    </FormField>
  );
}
