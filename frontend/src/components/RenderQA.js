import React from "react";
import { Spin, Tag, Tooltip, Alert } from "antd";
import { FileTextOutlined, GlobalOutlined } from "@ant-design/icons";

const containerStyle = {
  display: "flex",
  justifyContent: "space-between",
  flexDirection: "column",
  marginBottom: "20px",
};

const userContainer = {
  textAlign: "right",
};

const agentContainer = {
  textAlign: "left",
};

const userStyle = {
  maxWidth: "50%",
  textAlign: "left",
  backgroundColor: "#1677FF",
  color: "white",
  display: "inline-block",
  borderRadius: "10px",
  padding: "10px",
  marginBottom: "10px",
};

const answerLabel = {
  fontSize: "12px",
  fontWeight: "bold",
  color: "#666",
  marginBottom: "5px",
};

const answerStyle = {
  maxWidth: "70%",
  textAlign: "left",
  backgroundColor: "#F5F5F5",
  color: "black",
  display: "inline-block",
  borderRadius: "10px",
  padding: "10px",
  marginBottom: "5px",
  lineHeight: 1.7,
};

const sourceListStyle = {
  maxWidth: "70%",
  fontSize: "12px",
  color: "#555",
  marginTop: "4px",
};

const MODE_LABELS = {
  docs: "document only",
  web: "web only",
  hybrid: "document + web",
};

const WEB_FALLBACK_MESSAGES = {
  timeout: "Web search timed out — this answer uses the document only.",
  error: "Web search failed — this answer uses the document only.",
  empty: "Web search returned no results — this answer uses the document only.",
};

const RETRIEVAL_FALLBACK_MESSAGE = "Document retrieval failed — this answer uses web sources only.";

// Matches [D1], [W2], and grouped forms like [D1, W2] (same rules as the server's parser).
const CITATION_GROUP = /\[\s*([DW]\d+(?:\s*[,;]\s*[DW]\d+)*)\s*\]/g;

const sourceTooltip = (source) =>
  source.type === "document" ? (
    <span>
      Page {source.page ?? "?"}: {source.text.slice(0, 240)}…
    </span>
  ) : (
    <span>
      {source.title}
      <br />
      {source.url}
    </span>
  );

const CitationTag = ({ id, source }) => {
  if (!source) {
    return (
      <Tooltip title="This label doesn't match any source given to the model">
        <Tag color="error" style={{ marginInlineEnd: 2 }}>
          {id}?
        </Tag>
      </Tooltip>
    );
  }
  const tag = (
    <Tag color={source.type === "document" ? "blue" : "green"} style={{ marginInlineEnd: 2, cursor: "pointer" }}>
      {id}
    </Tag>
  );
  return (
    <Tooltip title={sourceTooltip(source)}>
      {source.type === "web" ? (
        <a href={source.url} target="_blank" rel="noreferrer">
          {tag}
        </a>
      ) : (
        tag
      )}
    </Tooltip>
  );
};

// Splits the answer text around citation markers and renders them as tags.
const AnswerText = ({ text, sources }) => {
  const byId = Object.fromEntries((sources || []).map((s) => [s.id, s]));
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(CITATION_GROUP)) {
    parts.push(text.slice(last, match.index));
    for (const id of match[1].split(/[,;]/).map((s) => s.trim())) {
      parts.push(<CitationTag key={`${match.index}-${id}`} id={id} source={byId[id]} />);
    }
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
};

const SourceList = ({ sources, citations }) => {
  if (!sources?.length) return null;
  const cited = new Set(citations?.cited || []);
  return (
    <div style={sourceListStyle}>
      {sources.map((s) => (
        <div key={s.id} style={{ opacity: citations && !cited.has(s.id) ? 0.55 : 1 }}>
          {s.type === "document" ? <FileTextOutlined /> : <GlobalOutlined />} <b>{s.id}</b>{" "}
          {s.type === "document" ? (
            `Document, page ${s.page ?? "?"}`
          ) : (
            <a href={s.url} target="_blank" rel="noreferrer">
              {s.title}
            </a>
          )}
        </div>
      ))}
      {citations && <div style={{ marginTop: 4, color: "#999" }}>Faded sources were given to the model but not cited.</div>}
    </div>
  );
};

const RenderQA = (props) => {
  const { conversation, isLoading } = props;

  return (
    <>
      {conversation?.map((each, index) => {
        const { text, sources, citations, web, retrieval, mode, error } = each.answer;
        return (
          <div key={index} style={containerStyle}>
            <div style={userContainer}>
              <div style={userStyle}>{each.question}</div>
            </div>
            <div style={agentContainer}>
              <div style={answerLabel}>Answer ({MODE_LABELS[mode] || mode}):</div>
              {WEB_FALLBACK_MESSAGES[web?.status] && mode === "hybrid" && (
                <Alert type="warning" showIcon message={WEB_FALLBACK_MESSAGES[web.status]} style={{ maxWidth: "70%", marginBottom: 6 }} />
              )}
              {retrieval?.status === "error" && mode === "hybrid" && (
                <Alert type="warning" showIcon message={RETRIEVAL_FALLBACK_MESSAGE} style={{ maxWidth: "70%", marginBottom: 6 }} />
              )}
              {error ? (
                <Alert type="error" showIcon message={error} style={{ maxWidth: "70%" }} />
              ) : (
                <div style={answerStyle}>
                  <AnswerText text={text || ""} sources={sources} />
                </div>
              )}
              <SourceList sources={sources} citations={citations} />
            </div>
          </div>
        );
      })}
      {isLoading && <Spin size="large" style={{ margin: "10px" }} />}
    </>
  );
};

export default RenderQA;
