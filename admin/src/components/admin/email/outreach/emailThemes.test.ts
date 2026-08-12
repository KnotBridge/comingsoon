import { describe, expect, it } from "vitest";
import {
  fromEmailHtml, normalizeEmailLinkInput, repairDuplicateUrlProtocols,
  themeByKey, themeKeyOf, toEmailHtml,
} from "./emailThemes";

function parse(html: string) {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("email theme serialization", () => {
  it("keeps selected font size and color through save and reopen", () => {
    const kingKong = themeByKey("kingkong");
    const saved = toEmailHtml(
      '<p>Hello <span style="font-size:15px;color:#cc2200">smaller red text</span></p>',
      kingKong,
    );

    const savedDoc = parse(saved);
    const wrapper = savedDoc.body.firstElementChild as HTMLElement;
    const paragraph = wrapper.querySelector("p") as HTMLElement;
    const span = wrapper.querySelector("span") as HTMLElement;

    expect(wrapper.dataset.theme).toBe("kingkong");
    expect(wrapper.style.maxWidth).toBe("620px");
    expect(paragraph.style.fontSize).toBe("20px");
    expect(span.style.fontSize).toBe("15px");
    expect(span.style.color).toBe("rgb(204, 34, 0)");

    const reopened = fromEmailHtml(saved);
    const reopenedDoc = parse(`<div>${reopened}</div>`);
    const reopenedParagraph = reopenedDoc.querySelector("p") as HTMLElement;
    const reopenedSpan = reopenedDoc.querySelector("span") as HTMLElement;

    expect(reopenedParagraph.style.fontSize).toBe("");
    expect(reopenedSpan.style.fontSize).toBe("15px");
    expect(reopenedSpan.style.color).toBe("rgb(204, 34, 0)");

    const savedAgain = toEmailHtml(reopened, kingKong);
    const savedAgainSpan = parse(savedAgain).querySelector("span") as HTMLElement;
    expect(savedAgainSpan.style.fontSize).toBe("15px");
    expect(savedAgainSpan.style.color).toBe("rgb(204, 34, 0)");
  });

  it("preserves block overrides when the theme defaults change", () => {
    const kingKong = themeByKey("kingkong");
    const clean = themeByKey("clean");
    const original = toEmailHtml(
      '<p>Body copy</p><p data-email-gap="32" data-email-line-height="19px" style="font-size:15px;line-height:19px;color:rgb(100,100,100);margin-bottom:32px">Signature</p>',
      kingKong,
    );
    const reopened = fromEmailHtml(original);
    const rethemed = toEmailHtml(reopened, clean);
    const paragraphs = parse(rethemed).querySelectorAll<HTMLElement>("p");

    expect(paragraphs[0].style.fontSize).toBe("15px");
    expect(paragraphs[0].style.lineHeight).toBe("24px");
    expect(paragraphs[1].style.fontSize).toBe("15px");
    expect(paragraphs[1].style.lineHeight).toBe("19px");
    expect(paragraphs[1].style.marginBottom).toBe("32px");
    expect(paragraphs[1].style.color).toBe("rgb(100, 100, 100)");
  });

  it("keeps a blank line without adding a second paragraph gap", () => {
    const saved = toEmailHtml("<p>First</p><p><br></p><p>Second</p>", themeByKey("kingkong"));
    const paragraphs = parse(saved).querySelectorAll<HTMLElement>("p");

    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0].style.marginBottom).toBe("24px");
    expect(paragraphs[1].style.marginBottom).toBe("0px");
    expect(paragraphs[1].textContent).toBe("\u00a0");

    const reopened = parse(`<div>${fromEmailHtml(saved)}</div>`).querySelectorAll<HTMLElement>("p");
    expect(reopened[1].dataset.emptyLine).toBe("true");
    expect(reopened[1].innerHTML.toLowerCase()).toBe("<br>");
  });

  it("supports an explicit No theme mode with only manual formatting", () => {
    const saved = toEmailHtml(
      '<p>Plain <span style="font-family:Georgia,serif;font-size:18px;color:#2455aa">but editable</span></p>',
      themeByKey("none"),
    );
    const doc = parse(saved);
    const wrapper = doc.body.firstElementChild as HTMLElement;
    const paragraph = wrapper.querySelector("p") as HTMLElement;
    const span = wrapper.querySelector("span") as HTMLElement;

    expect(themeKeyOf(saved)).toBe("none");
    expect(wrapper.getAttribute("style")).toBeNull();
    expect(wrapper.hasAttribute("data-column-width")).toBe(false);
    expect(paragraph.style.fontFamily).toBe("");
    expect(paragraph.style.fontSize).toBe("");
    expect(span.style.fontFamily).toContain("Georgia");
    expect(span.style.fontSize).toBe("18px");
    expect(span.style.color).toBe("rgb(36, 85, 170)");
  });

  it("keeps a signature table standalone without recreating blank lines", () => {
    const legacy = [
      '<div data-theme="kingkong" data-column-width="620">',
      '<p>Justin</p>',
      '<p>&nbsp;</p><p>&nbsp;</p>',
      '<p style="margin:0 0 24px 0"><table role="presentation"><tbody><tr><td>Renov AI</td></tr></tbody></table></p>',
      '<p>&nbsp;</p><p>&nbsp;</p>',
      '</div>',
    ].join("");

    const reopened = fromEmailHtml(legacy);
    const saved = toEmailHtml(reopened, themeByKey("kingkong"));
    const savedAgain = toEmailHtml(fromEmailHtml(saved), themeByKey("kingkong"));
    const doc = parse(savedAgain);
    const wrapper = doc.body.firstElementChild as HTMLElement;
    const table = wrapper.querySelector("table") as HTMLTableElement;

    expect(table.parentElement).toBe(wrapper);
    expect(wrapper.querySelectorAll("p")).toHaveLength(1);
    expect(wrapper.querySelector("p")?.textContent).toBe("Justin");
  });
});

describe("email links", () => {
  it("keeps a dynamic-page placeholder as the complete href", () => {
    expect(normalizeEmailLinkInput("{{dynamic_page_url}}")).toBe("{{dynamic_page_url}}");
    expect(normalizeEmailLinkInput("https://{{ dynamic_page_url }}")).toBe("{{dynamic_page_url}}");
    expect(normalizeEmailLinkInput("renov.space/r/example")).toBe("https://renov.space/r/example");
    expect(normalizeEmailLinkInput("mailto:hello@renov.space")).toBe("mailto:hello@renov.space");
    expect(normalizeEmailLinkInput("hello@renov.space")).toBe("mailto:hello@renov.space");
  });

  it("repairs a legacy placeholder link when the template is saved", () => {
    const saved = toEmailHtml(
      '<p><a href="https://{{dynamic_page_url}}">See the listing</a></p>',
      themeByKey("kingkong"),
    );
    expect(parse(saved).querySelector("a")?.getAttribute("href")).toBe("{{dynamic_page_url}}");
  });

  it("repairs links saved with two URL protocols", () => {
    expect(repairDuplicateUrlProtocols('href="https://https://renov.space/r/example"'))
      .toBe('href="https://renov.space/r/example"');
  });
});
