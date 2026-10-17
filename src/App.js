import React, { useState, useEffect } from "react";
import PdfUploader from "./components/PdfUploader";
import ChatComponent from "./components/ChatComponent";
import RenderQA from "./components/RenderQA";
import { Layout, Typography } from "antd";

const chatComponentStyle = {
  position: "fixed",
  bottom: "0",
  width: "80%",
  left: "10%",
  marginBottom: "20px",
};

const pdfUploaderStyle = {
  margin: "auto",
  paddingTop: "80px",
};

const renderQAStyle = {
  height: "50%",
  overflowY: "auto",
};

const App = () => {
  const [conversation, setConversation] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [documentId, setDocumentId] = useState(null);

  // On mount: load the default document so the user can chat immediately
  // without uploading anything. Polls until ingestion is complete.
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch("http://localhost:5001/documents/default");
        if (!res.ok) return; // not ready yet, keep polling
        const doc = await res.json();
        if (doc.status === "ready") {
          setDocumentId(doc.id);
        }
      } catch {
        // server not up yet, keep polling
      }
    };

    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, []);
  const { Header, Content } = Layout;
  const { Title } = Typography;

  const handleResp = (question, answer) => {
    setConversation((prev) => [...prev, { question, answer }]);
  };

  // Merges partial updates (ragAnswer tokens, mcpAnswer) into the last entry.
  // Called repeatedly by the streaming path as tokens arrive.
  const updateLastAnswer = (updates) => {
    setConversation((prev) => {
      const updated = [...prev];
      const last = { ...updated[updated.length - 1] };
      last.answer = { ...last.answer, ...updates };
      updated[updated.length - 1] = last;
      return updated;
    });
  };

  return (
    <>
      <Layout style={{ height: "100vh", backgroundColor: "white" }}>
        <Header style={{ display: "flex", alignItems: "center" }}>
          <Title style={{ color: "white " }}>Agent AI</Title>
        </Header>
        <Content style={{ width: "80%", margin: "auto" }}>
          <div style={pdfUploaderStyle}>
            <PdfUploader onDocumentReady={setDocumentId} />
          </div>

          <br />
          <br />
          <div style={renderQAStyle}>
            <RenderQA conversation={conversation} isLoading={isLoading} />
          </div>

          <br />
          <br />
        </Content>
        <div style={chatComponentStyle}>
          <ChatComponent
            handleResp={handleResp}
            updateLastAnswer={updateLastAnswer}
            isLoading={isLoading}
            setIsLoading={setIsLoading}
            documentId={documentId}
          />
        </div>
      </Layout>
    </>
  );
};

export default App;
