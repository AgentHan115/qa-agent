import React, { useState, useEffect } from "react";
import { Button, Input, Segmented } from "antd";
import { AudioOutlined } from "@ant-design/icons";
import SpeechRecognition, {
  useSpeechRecognition,
} from "react-speech-recognition";
import Speech from "speak-tts";

const { Search } = Input;

const DOMAIN = "http://localhost:5001";

const searchContainer = {
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
};

const MODE_OPTIONS = [
  { label: "Doc + Web", value: "hybrid" },
  { label: "Doc only", value: "docs" },
  { label: "Web only", value: "web" },
];

// Citation labels like [D1][W2] shouldn't be read aloud.
const stripCitations = (text) => text.replace(/\s*\[\s*[DW]\d+(?:\s*[,;]\s*[DW]\d+)*\s*\]/g, "");

const ChatComponent = (props) => {
  const { handleResp, updateLastAnswer, isLoading, setIsLoading, documentId } = props;
  // Define a state variable to keep track of the search value
  const [searchValue, setSearchValue] = useState("");
  const [isChatModeOn, setIsChatModeOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [speech, setSpeech] = useState();
  const [mode, setMode] = useState("hybrid");

  // speech recognation
  const {
    transcript,
    listening,
    resetTranscript,
  } = useSpeechRecognition();

  useEffect(() => {
    const initialized_speech = new Speech();
    initialized_speech
      .init({
        volume: 1,
        lang: "en-US",
        rate: 1,
        pitch: 1,
        voice: "Google US English",
        splitSentences: false,
      })
      .then((data) => {
        // The "data" object contains the list of available voices and the voice synthesis params
        console.log("Speech is ready, voices are available", data);
        setSpeech(initialized_speech);
      })
      .catch((e) => {
        console.error("An error occured while initializing : ", e);
      });
  }, []);

  useEffect(() => {
    if (!listening && Boolean(transcript)) {
      (async () => await onSearch(transcript))();
      setIsRecording(false);
    }
    // Runs only when a recording finishes; onSearch is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening, transcript]);

  const talk = (what2say) => {
    speech
      .speak({
        text: what2say,
        queue: false, // current speech will be interrupted
      })
      .then(() => {
        // When the answer has been read out, listen for the next question.
        userStartConvo();
      })
      .catch((e) => {
        console.error("An error occurred :", e);
      });
  };

  const userStartConvo = () => {
    SpeechRecognition.startListening();
    setIsRecording(true);
    resetTranscript();
  };

  const chatModeClickHandler = () => {
    setIsChatModeOn(!isChatModeOn);
    setIsRecording(false);
    SpeechRecognition.stopListening();

    resetTranscript();
  };

  const recordingClickHandler = () => {
    if (isRecording) {
      setIsRecording(false);
      SpeechRecognition.stopListening();

      resetTranscript();
    } else {
      setIsRecording(true);
      SpeechRecognition.startListening();
    }
  };

  const onSearch = (question) => {
    if (!question?.trim()) return;
    if (!documentId && mode !== "web") {
      handleResp(question, { mode, error: "Please upload a PDF first, or switch to Web only." });
      return;
    }

    setSearchValue("");
    setIsLoading(true);

    // Push a placeholder entry immediately — sources and tokens fill it in as they arrive
    handleResp(question, { mode, text: "", sources: [] });

    const params = new URLSearchParams({ question, mode });
    if (documentId && mode !== "web") params.set("documentId", documentId);
    const es = new EventSource(`${DOMAIN}/chat/stream?${params}`);

    let accumulated = "";
    const t0 = Date.now();
    let ttft = null;

    // Sent once retrieval/search finish, before the first answer token.
    es.addEventListener("sources", (e) => {
      const { sources, web, retrieval } = JSON.parse(e.data);
      updateLastAnswer({ sources, web, retrieval });
    });

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.token) {
        if (!ttft) {
          ttft = Date.now() - t0;
          console.log(`[stream] time-to-first-token: ${ttft}ms`);
        }
        accumulated += data.token;
        updateLastAnswer({ text: accumulated });
      }
      if (data.done) {
        console.log(`[stream] total time: ${Date.now() - t0}ms`, data.meta);
        updateLastAnswer({ citations: data.citations });
        es.close();
        setIsLoading(false);
        if (isChatModeOn) talk(stripCitations(accumulated));
      }
    };

    es.addEventListener("apierror", (e) => {
      const data = JSON.parse(e.data);
      updateLastAnswer({ error: data.detail ? `${data.error}: ${data.detail}` : data.error });
      es.close();
      setIsLoading(false);
    });

    es.onerror = () => {
      // Fires for HTTP errors before the stream starts too (e.g. 409 still processing)
      if (!accumulated) updateLastAnswer({ error: "Connection error." });
      es.close();
      setIsLoading(false);
    };
  };

  const handleChange = (e) => {
    // Update searchValue state when the user types in the input box
    setSearchValue(e.target.value);
  };

  return (
    <div style={searchContainer}>
      <Segmented
        options={MODE_OPTIONS}
        value={mode}
        onChange={setMode}
        disabled={isLoading}
        style={{ marginRight: "8px" }}
      />
      {!isChatModeOn && (
        <Search
          placeholder="input search text"
          enterButton="Ask"
          size="large"
          onSearch={onSearch}
          loading={isLoading}
          value={searchValue} // Control the value
          onChange={handleChange} // Update the value when changed
        />
      )}
      <Button
        type="primary"
        size="large"
        danger={isChatModeOn}
        onClick={chatModeClickHandler}
        style={{ marginLeft: "5px" }}
      >
        Chat Mode: {isChatModeOn ? "On" : "Off"}
      </Button>
      {isChatModeOn && (
        <Button
          type="primary"
          icon={<AudioOutlined />}
          size="large"
          danger={isRecording}
          onClick={recordingClickHandler}
          style={{ marginLeft: "5px" }}
        >
          {isRecording ? "Recording..." : "Click to record"}
        </Button>
      )}
    </div>
  );
};

export default ChatComponent;
