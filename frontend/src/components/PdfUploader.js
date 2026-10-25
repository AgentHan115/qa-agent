import React, { useState } from "react";
import axios from "axios";
import { InboxOutlined } from "@ant-design/icons";
import { message, Upload, Tag } from "antd";
import { API_URL } from "../api";

const { Dragger } = Upload;

// Poll GET /documents/:documentId until status is "ready" or "failed"
const pollStatus = (documentId, onReady, onFailed) => {
  const interval = setInterval(async () => {
    try {
      const { data } = await axios.get(`${API_URL}/documents/${documentId}`);
      if (data.status === "ready") {
        clearInterval(interval);
        onReady(data);
      } else if (data.status === "failed") {
        clearInterval(interval);
        onFailed(data.error);
      }
    } catch {
      clearInterval(interval);
      onFailed("Status check failed");
    }
  }, 1500);
};

const PdfUploader = ({ onDocumentReady }) => {
  const [ingestStatus, setIngestStatus] = useState(null); // null | "processing" | "ready" | "failed"
  const [filename, setFilename] = useState(null);

  const attributes = {
    name: "file",
    multiple: false,
    accept: ".pdf",
    customRequest: async ({ file, onSuccess, onError }) => {
      const formData = new FormData();
      formData.append("file", file);

      try {
        const { data } = await axios.post(`${API_URL}/upload`, formData, {
          headers: { "Content-Type": "multipart/form-data" },
        });

        setFilename(data.filename);
        setIngestStatus("processing");
        onSuccess(data);

        // Poll until Chroma has stored all embeddings
        pollStatus(
          data.documentId,
          (doc) => {
            setIngestStatus("ready");
            onDocumentReady(data.documentId);
            message.success(`"${doc.filename}" indexed — ${doc.chunk_count} chunks stored`);
          },
          (err) => {
            setIngestStatus("failed");
            message.error(`Ingestion failed: ${err}`);
          }
        );
      } catch (error) {
        onError(error);
        message.error("Upload failed");
      }
    },
    onChange(info) {
      if (info.file.status === "error") {
        message.error(`${info.file.name} upload failed`);
      }
    },
  };

  const statusTag = () => {
    if (!ingestStatus) return null;
    const map = {
      processing: { color: "processing", text: `Indexing "${filename}"…` },
      ready: { color: "success", text: `"${filename}" ready` },
      failed: { color: "error", text: "Ingestion failed" },
    };
    const { color, text } = map[ingestStatus];
    return <Tag color={color} style={{ marginTop: 12 }}>{text}</Tag>;
  };

  return (
    <div>
      <Dragger {...attributes}>
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">Click or drag a PDF to upload</p>
        <p className="ant-upload-hint">
          The document will be indexed into the vector database. You can start
          asking questions once the status shows "ready".
        </p>
      </Dragger>
      {statusTag()}
    </div>
  );
};

export default PdfUploader;
