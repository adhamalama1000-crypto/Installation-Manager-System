import { describe, expect, it } from "vitest";
import { createT } from "@/i18n/translator";
import { customerReminder, technicianMessage, whatsappLink, whatsappNumber } from "@/lib/day-plan";

const en = createT("en");
const ar = createT("ar");

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
    const visits = [
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
    ];
    const text = technicianMessage(en, "Karim Fathy", "Saturday 14 March", visits);
    expect(text).toContain("Good morning Karim 👋");
    expect(text).toContain("1) ⏰ 10:00–12:00 · Installation: Smart Lock · Yale Linus L2");
    expect(text).toContain("👤 Ahmed Fouad · 📞 +20 100 123 4567");
    expect(text).toContain("💰 To collect: 3,000 EGP");
    expect(text).toContain("👷 With: Youssef Nabil");
    expect(text).toContain("#APT-000012");
    expect(text).not.toContain("📝");
    expect(customerReminder(en, "Ahmed", "Saturday 14 March", "10:00", "Installation", "Aura Smart Homes")).toContain("This is Aura Smart Homes. A reminder of your installation visit on Saturday 14 March at 10:00.");
  });

  it("writes the messages in Arabic for Arabic users", () => {
    const text = technicianMessage(ar, "كريم فتحي", "السبت 14 مارس", [
      { code: "APT-000012", time: "10:00–12:00", what: "تركيب: قفل ذكي", customerName: "أحمد", customerPhone: null, address: "", mapLink: null, equipment: null, notes: null, toCollect: 3000, withOthers: [] },
    ]);
    expect(text).toContain("صباح الخير يا كريم 👋");
    expect(text).toContain("💰 المطلوب تحصيله: 3,000 ج.م");
    expect(customerReminder(ar, "أحمد", "السبت 14 مارس", "10:00", "تركيب", "أورا")).toContain("معاك أورا");
  });

  it("asks the customer to prepare the site for the product, as Aura's prepText did", () => {
    const lock = customerReminder(en, "Ahmed", "Saturday 14 March", "10:00", "Installation", "Aura", "SMART_LOCK").split("\n");
    expect(lock).toEqual([
      "Hello Ahmed 👋",
      "This is Aura. A reminder of your installation visit on Saturday 14 March at 10:00.",
      "So the technician can finish in one visit, please have the following ready:",
      "🚪 The door ready, with no carpentry work left on it",
      "📱 Your phone with you so we can set up the lock's app",
      "🔑 An adult at the location at the visit time",
      "If you need another time, just reply to this message. Thank you 🙏",
    ]);
    const smart = customerReminder(ar, "أحمد", "السبت 14 مارس", "10:00", "تركيب", "أورا", "SMART_HOME");
    expect(smart).toContain("عشان الفني يخلص في زيارة واحدة، لو سمحت جهّز الآتي:");
    expect(smart).toContain("📶 الإنترنت (الراوتر) شغال وباسورد الواي فاي جاهز");
    expect(smart).toContain("🔧 التأسيس / النجارة خلصانة");
    expect(smart).not.toContain("🚪");
    // Other products keep the general line.
    const cctv = customerReminder(en, "Ahmed", "Saturday 14 March", "10:00", "Installation", "Aura", "CCTV");
    expect(cctv).toContain("Please make sure someone is at the location and the site is ready");
    expect(cctv).not.toContain("So the technician can finish in one visit");
  });
});
