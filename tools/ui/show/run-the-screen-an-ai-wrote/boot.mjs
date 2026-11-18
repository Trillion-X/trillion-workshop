// The page's start: its own words (the JSON beside the screen) and the AI app's bridge, handed to the runner.
import { connectToAiApp } from '../ai-app-bridge/ai-app-bridge.mjs';
import { runScreens } from './runner.mjs';

const words = (() => { try { return JSON.parse(document.getElementById('screen-words')?.textContent || '{}'); } catch { return {}; } })();
runScreens(window, { words, connect: hearing => connectToAiApp(window, { appName: 'screen', ...hearing }) });
