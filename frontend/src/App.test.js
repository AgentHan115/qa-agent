import { render, screen, within } from "@testing-library/react";
import App from "./App";
import RenderQA from "./components/RenderQA";

test("renders the app with the source-mode switch", () => {
  render(<App />);
  expect(screen.getByText("Agent AI")).toBeInTheDocument();
  for (const label of ["Doc + Web", "Doc only", "Web only"]) {
    expect(screen.getByText(label)).toBeInTheDocument();
  }
});

const sources = [
  { id: "D1", type: "document", page: 5, text: "An MVP tests a hypothesis." },
  { id: "W1", type: "web", title: "MVP - Wikipedia", url: "https://en.wikipedia.org/wiki/MVP", snippet: "..." },
];

test("renders citations as tags and lists sources with pages and links", () => {
  render(
    <RenderQA
      conversation={[
        {
          question: "What is an MVP?",
          answer: {
            mode: "hybrid",
            text: "An MVP tests a hypothesis [D1]. It is widely discussed [W1][W9].",
            sources,
            citations: { cited: ["D1", "W1"], invalid: ["W9"] },
            web: { status: "ok" },
          },
        },
      ]}
      isLoading={false}
    />
  );
  expect(screen.getByText("Answer (document + web):")).toBeInTheDocument();
  expect(screen.getAllByText("D1").length).toBeGreaterThan(0);
  expect(screen.getByText("W9?")).toBeInTheDocument(); // invalid label is flagged
  expect(screen.getByText("Document, page 5")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "MVP - Wikipedia" })).toHaveAttribute("href", sources[1].url);
  // Citation markers are rendered as tags, not left as raw "[D1]" text
  expect(screen.queryByText(/\[D1\]/)).not.toBeInTheDocument();
});

test("warns when hybrid mode had to answer from the document alone", () => {
  render(
    <RenderQA
      conversation={[
        {
          question: "q",
          answer: { mode: "hybrid", text: "From the document [D1].", sources: [sources[0]], web: { status: "timeout" } },
        },
      ]}
      isLoading={false}
    />
  );
  const alert = screen.getByRole("alert");
  expect(within(alert).getByText(/Web search timed out/)).toBeInTheDocument();
});

test("warns when hybrid mode had to answer from the web alone", () => {
  render(
    <RenderQA
      conversation={[
        {
          question: "q",
          answer: { mode: "hybrid", text: "From the web [W1].", sources: [sources[1]], web: { status: "ok" }, retrieval: { status: "error" } },
        },
      ]}
      isLoading={false}
    />
  );
  expect(within(screen.getByRole("alert")).getByText(/Document retrieval failed/)).toBeInTheDocument();
});
