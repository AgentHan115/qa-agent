// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// react-speech-recognition expects a global regeneratorRuntime (see its README);
// the app bundle gets one from Babel, Jest doesn't.
import 'regenerator-runtime/runtime';
