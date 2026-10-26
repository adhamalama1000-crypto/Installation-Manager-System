import { describe, expect, it } from "vitest";
import { customerReminder, technicianMessage, whatsappLink, whatsappNumber } from "@/lib/day-plan";

describe("WhatsApp links", () => {
  it("turns local and international numbers into wa.me digits", () => {
    expect(whatsappNumber("0100 123 4567")).toBe("201001234567");
    expect(whatsappNumber("+20 (100) 123-4567")).toBe("201001234567");
    expect(whatsappNumber("00971 50 123 4567")).toBe("971501234567");
    expect(whatsappNumber("")).toBe("");
    expect(whatsappNumber(null)).toBe("");
  });

  it("encodes the text and leaves the number empty when unknown", () => {
    expect(whatsappLink("0100 123 4567", "Hi & bye\n2")).toBe("https://wa.me/201001234567?text=Hi%20%26%20bye%0A2");
    expect(whatsappLink(null, "x")).toBe("https://wa.me/?text=x");
  });
});

describe("messages", () => {
  it("lists each visit with what the technician needs", () => {
    const text = technicianMessage("Karim Fathy", "Saturday 14 March", [
      {
        code: "APT-000012",
        time: "10:00–12:00",
        what: "Installation: Smart Lock · Yale Linus L2",
        customerName: "Ahmed Fouad",
        customerPhone: "+20 100 123 4567",
        address: "New Cairo, Mivida, Apt 14B",
        mapLink: "https://maps.app.goo.gl/x",
        equipment: "Drill",
        notes: null,
        toCollect: 3000,
        withOthers: ["Youssef Nabil"],
      },
    ]);
    expect(text).toContain("Good morning Karim 👋");
    expect(text).toContain("1) ⏰ 10:00–12:00 · Installation: Smart Lock · Yale Linus L2");
    expect(text).toContain("👤 Ahmed Fouad · 📞 +20 100 123 4567");
    expect(text).toContain("💰 To collect: 3,000 EGP");
    expect(text).toContain("👷 With: Youssef Nabil");
    expect(text).toContain("#APT-000012");
    expect(text).not.toContain("📝");
    expect(customerReminder("Ahmed", "Saturday 14 March", "10:00", "Installation", "Aura Smart Homes")).toContain("This is Aura Smart Homes. A reminder of your installation visit on Saturday 14 March at 10:00.");
  });
});
