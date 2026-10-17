import React, { useState, useEffect } from "react";
import { Button, Input } from "antd";
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
};

const ChatComponent = (props) => {
  const { handleResp, updateLastAnswer, isLoading, setIsLoading, documentId } = props;
  // Define a state variable to keep track of the search value
  const [searchValue, setSearchValue] = useState("");
  const [isChatModeOn, setIsChatModeOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [speech, setSpeech] = useState();

  // speech recognation
  const {
    transcript,
    listening,
    resetTranscript,
    browserSupportsSpeechRecognition,
    isMicrophoneAvailable,
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
  }, [listening, transcript]);

  const talk = (what2say) => {
    speech
      .speak({
        text: what2say,
        queue: false, // current speech will be interrupted,
        listeners: {
          onstart: () => {
            console.log("Start utterance");
          },
          onend: () => {
            console.log("End utterance");
          },
          onresume: () => {
            console.log("Resume utterance");
          },
          onboundary: (event) => {
            console.log(
              event.name +
                " boundary reached after " +
                event.elapsedTime +
                " milliseconds."
            );
          },
        },
      })
      .then(() => {
        // if everyting went well, start listening again
        console.log("Success !");
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
    if (!documentId) {
      handleResp(question, { ragAnswer: "Please upload a PDF first.", mcpAnswer: "" });
      return;
    }

    setSearchValue("");
    setIsLoading(true);

    // Push a placeholder entry immediately — tokens will fill it in as they arrive
    handleResp(question, { ragAnswer: "", mcpAnswer: "" });

    const params = new URLSearchParams({ question });
    if (documentId) params.set("documentId", documentId);
    const es = new EventSource(`${DOMAIN}/chat/stream?${params}`);

    let accumulated = "";
    const t0 = Date.now();
    let ttft = null;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.token) {
        if (!ttft) {
          ttft = Date.now() - t0;
          console.log(`[stream] time-to-first-token: ${ttft}ms`);
        }
        accumulated += data.token;
        updateLastAnswer({ ragAnswer: accumulated });
      }
      if (data.done) {
        console.log(`[stream] total time: ${Date.now() - t0}ms`);
        updateLastAnswer({ mcpAnswer: data.mcpAnswer });
        es.close();
        setIsLoading(false);
        if (isChatModeOn) talk(accumulated);
      }
    };

    es.addEventListener("apierror", (e) => {
      const data = JSON.parse(e.data);
      updateLastAnswer({ ragAnswer: `Error: ${data.error}` });
      es.close();
      setIsLoading(false);
    });

    es.onerror = () => {
      updateLastAnswer({ ragAnswer: accumulated || "Connection error." });
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
