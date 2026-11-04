import { describe, expect, it } from "vitest";
import { filterOptions, foldText } from "@/components/ui/combobox";

describe("searchable pickers", () => {
  it("fold Arabic letter forms, diacritics and case", () => {
    expect(foldText("أحمد")).toBe(foldText("احمد"));
    expect(foldText("مُصطفى")).toBe("مصطفي");
    expect(foldText("كاميرا ذكية")).toBe(foldText("كاميرا ذكيه"));
    expect(foldText("  Yale LOCK ")).toBe("yale lock");
  });

  it("match every typed word in any order, in the label, hint or keywords", () => {
    const options = [
      { id: "1", label: "Yale smart lock", hint: "SL-000001" },
      { id: "2", label: "Hikvision camera", hint: "CAM-000002", keywords: "كاميرا" },
      { id: "3", label: "قفل ذكي أسود", hint: "SL-000003" },
    ];
    expect(filterOptions(options, "lock yale").map((o) => o.id)).toEqual(["1"]);
    expect(filterOptions(options, "cam-000002").map((o) => o.id)).toEqual(["2"]);
    expect(filterOptions(options, "كاميرا").map((o) => o.id)).toEqual(["2"]);
    expect(filterOptions(options, "اسود").map((o) => o.id)).toEqual(["3"]);
    expect(filterOptions(options, "").length).toBe(3);
    expect(filterOptions(options, "", 2).length).toBe(2);
  });
});
