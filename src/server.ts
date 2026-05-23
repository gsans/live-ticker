import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';

const browserDistFolder = join(import.meta.dirname, '../browser');

interface AlertRule {
  symbol: string;
  condition: 'above' | 'below';
  targetPrice: number;
  triggered: boolean;
}

interface CustomWebSocket extends WebSocket {
  alertRules?: AlertRule[];
}

interface GeminiLiveSession {
  sendRealtimeInput(input: {
    audio?: { data: string; mimeType: string };
    text?: string;
  }): void;
  close(): void;
}

interface AudioTranscriptExtended {
  outputAudioTranscription?: { text?: string };
  inputAudioTranscription?: { text?: string };
}

const app = express();
const angularApp = new AngularNodeAppEngine();

// Parse JSON payloads
app.use(express.json());

// Market asset tickers datastore
interface MarketTicker {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  prices: number[];
  sma: number;
  rsi: number;
  upperBand: number;
  lowerBand: number;
}

const tickers: MarketTicker[] = [
  { symbol: 'AAPL', name: 'Apple Inc.', price: 175.50, change: 0, changePercent: 0, prices: [174.5, 175.0, 175.2, 175.4, 175.1, 175.3, 175.5], sma: 175.1, rsi: 50.0, upperBand: 176.0, lowerBand: 174.0 },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', price: 152.20, change: 0, changePercent: 0, prices: [151.0, 151.5, 151.8, 152.0, 151.9, 152.1, 152.2], sma: 151.8, rsi: 53.0, upperBand: 152.8, lowerBand: 150.8 },
  { symbol: 'TSLA', name: 'Tesla Motors', price: 170.80, change: 0, changePercent: 0, prices: [172.5, 171.8, 171.2, 170.9, 171.1, 170.9, 170.8], sma: 171.3, rsi: 34.0, upperBand: 173.5, lowerBand: 169.1 },
  { symbol: 'MSFT', name: 'Microsoft Corp.', price: 415.30, change: 0, changePercent: 0, prices: [412.0, 413.5, 414.2, 414.8, 414.5, 415.0, 415.3], sma: 414.2, rsi: 62.0, upperBand: 416.8, lowerBand: 411.6 },
  { symbol: 'BTC-USD', name: 'Bitcoin / USD', price: 89450.00, change: 0, changePercent: 0, prices: [88900, 89100, 89300, 89250, 89400, 89350, 89450], sma: 89250, rsi: 58.0, upperBand: 89680, lowerBand: 88820 },
  { symbol: 'ETH-USD', name: 'Ethereum / USD', price: 3120.50, change: 0, changePercent: 0, prices: [3080, 3105, 3115, 3110, 3125, 3118, 3120.5], sma: 3110.5, rsi: 55.0, upperBand: 3145, lowerBand: 3075 },
];

/**
 * Update stock ticker pricing based on random walk model and calculate SMA, RSI, and Bollinger bands
 */
function updateTickerPrices() {
  tickers.forEach(ticker => {
    const prevPrice = ticker.price;
    const volatility = ticker.symbol.includes('USD') ? 0.0035 : 0.0015; // Crypto has higher volatility
    const drift = 0.00008; // Mild upward drift
    const pctChange = (Math.random() - 0.495) * volatility + drift;
    
    ticker.price = Number((ticker.price * (1 + pctChange)).toFixed(2));
    ticker.change = Number((ticker.price - prevPrice).toFixed(2));
    ticker.changePercent = Number(((ticker.change / prevPrice) * 100).toFixed(2));
    
    ticker.prices.push(ticker.price);
    if (ticker.prices.length > 20) {
      ticker.prices.shift();
    }
    
    // Simple Moving Average (SMA) over last 7 periods
    const last7 = ticker.prices.slice(-7);
    const sum = last7.reduce((a, b) => a + b, 0);
    ticker.sma = Number((sum / last7.length).toFixed(2));
    
    // Relative Strength Index (RSI) over last 7 periods
    let gains = 0;
    let losses = 0;
    for (let i = 1; i < last7.length; i++) {
      const diff = last7[i] - last7[i - 1];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    const rs = losses === 0 ? 100 : gains / losses;
    ticker.rsi = Number((losses === 0 ? 100 : 100 - (100 / (1 + rs))).toFixed(1));
    
    // Bollinger Bands (1.8 Standard Deviations from average)
    const avg = sum / last7.length;
    const variance = last7.reduce((sumVal, val) => sumVal + Math.pow(val - avg, 2), 0) / last7.length;
    const stdDev = Math.sqrt(variance);
    ticker.upperBand = Number((avg + 1.8 * stdDev).toFixed(2));
    ticker.lowerBand = Number((avg - 1.8 * stdDev).toFixed(2));
  });
}

// Technical strategy suggestions datastore
interface StrategySuggestion {
  id: string;
  ticker: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  strategyName: string;
  price: number;
  reason: string;
  timestamp: string;
}

const strategySuggestions: StrategySuggestion[] = [];

/**
 * Evaluates triggers and logs automated buy/sell indicators
 */
function checkStrategyTriggers() {
  tickers.forEach(t => {
    let triggered = false;
    let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
    let strategyName = '';
    let reason = '';
    
    if (t.rsi < 30) {
      action = 'BUY';
      strategyName = 'RSI Oversold Momentum';
      reason = `${t.symbol} fell under oversold boundary of 30 (Current RSI: ${t.rsi}). Price is trading near lower Bollinger limits ($${t.lowerBand}), indicating structural exhaustion. Excellent risk-to-reward ratio for long positioning.`;
      triggered = true;
    } else if (t.rsi > 70) {
      action = 'SELL';
      strategyName = 'RSI Overbought Resistance';
      reason = `${t.symbol} printed overbought levels above 70 (Current RSI: ${t.rsi}). Prices stretched beyond Bollinger bands floor ($${t.upperBand}). Mean-reverting compression is historically probable. Recommend taking profits.`;
      triggered = true;
    } else if (t.price <= t.lowerBand) {
      action = 'BUY';
      strategyName = 'Bollinger Band Support Rebound';
      reason = `${t.symbol} hit strong outer Support Floor ($${t.lowerBand}). Current valuation points towards high buying pressure, suggesting momentum will defend this region. Prepare entry thresholds.`;
      triggered = true;
    } else if (t.price >= t.upperBand) {
      action = 'SELL';
      strategyName = 'Bollinger Band Resistance Reversal';
      reason = `${t.symbol} punched through intermediate valuation ceiling near upper Bollinger boundary limit ($${t.upperBand}). Selling pressure is accelerating on technical signals. Consider shorting or trimming.`;
      triggered = true;
    }
    
    if (triggered) {
      // Limit suggestion duplication frequency for active symbols (15s minimum spacing filter)
      const lastIndex = strategySuggestions.findIndex(s => s.ticker === t.symbol);
      const isNewSuggestionValid = lastIndex === -1 ? true : (Date.now() - new Date(strategySuggestions[lastIndex].timestamp).getTime() > 15000);
      
      if (isNewSuggestionValid) {
        const item: StrategySuggestion = {
          id: Math.random().toString(36).substring(2, 9),
          ticker: t.symbol,
          action,
          strategyName,
          price: t.price,
          reason,
          timestamp: new Date().toISOString()
        };
        strategySuggestions.unshift(item);
        if (strategySuggestions.length > 50) strategySuggestions.pop();
        
        // Push live strategy suggestions to all client WebSockets
        broadcastToClients({ type: 'strategy-suggestion', suggestion: item });
      }
    }
  });
}

// Conversation Transcription Logs
interface LogEntry {
  id: string;
  timestamp: string;
  role: 'user' | 'model';
  text: string;
}
const transcriptionLogs: LogEntry[] = [];

// REST Endpoints for cold loading
app.get('/api/market/tickers', (req, res) => {
  res.json({ tickers });
});

app.get('/api/market/strategies', (req, res) => {
  res.json({ suggestions: strategySuggestions });
});

app.get('/api/market/logs', (req, res) => {
  res.json({ logs: transcriptionLogs });
});

// Serve static assets from /browser
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

// Fallback to Angular SSR rendering handler
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

// Websocket Clients list
const activeClients = new Set<WebSocket>();

function broadcastToClients(payload: unknown) {
  const payloadStr = JSON.stringify(payload);
  activeClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payloadStr);
    }
  });
}

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Explicit server upgrade logic for WebSockets to accommodate Angular SSR framework
server.on('upgrade', (request, socket, head) => {
  const parsedUrl = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
  if (parsedUrl.pathname === '/api/live-ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// WebSocket orchestration callback
wss.on('connection', async (clientWs) => {
  activeClients.add(clientWs);
  console.log('CLIENT CONNECTED to Financial Live API service.');
  
  // Instant bootstrap payloads
  clientWs.send(JSON.stringify({ type: 'market-data-tick', tickers }));
  clientWs.send(JSON.stringify({ type: 'history-suggestions', suggestions: strategySuggestions }));
  clientWs.send(JSON.stringify({ type: 'history-logs', logs: transcriptionLogs }));
  
  let geminiSession: GeminiLiveSession | null = null;
  
  clientWs.on('message', async (messageData) => {
    try {
      const payload = JSON.parse(messageData.toString());
      
      if (payload.type === 'start-session') {
        const apiKey = process.env['GEMINI_API_KEY'];
        if (!apiKey) {
          clientWs.send(JSON.stringify({
            type: 'error',
            message: 'GEMINI_API_KEY is missing. Please configure your API key in the AI Studio Settings > Secrets panel.'
          }));
          return;
        }
        
        const ai = new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build'
            }
          }
        });
        
        console.log('INITIATING Live Gemini API with voice config:', payload.voice);
        
        const sessionConn = await ai.live.connect({
          model: 'gemini-3.1-flash-live-preview',
          callbacks: {
            onmessage: (liveMsg: LiveServerMessage) => {
              // Extract model generated audio chunk
              const modelAudio = liveMsg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
              if (modelAudio) {
                clientWs.send(JSON.stringify({ type: 'gemini-audio', data: modelAudio }));
              }
              
              // Extract text stream response
              let partText = '';
              if (liveMsg.serverContent?.modelTurn?.parts) {
                for (const part of liveMsg.serverContent.modelTurn.parts) {
                   if (part.text) {
                    partText += part.text;
                  }
                }
              }
              
              if (partText) {
                clientWs.send(JSON.stringify({ type: 'text-output', text: partText }));
              }
              
              // Retrieve speech transcription outcomes
              const extendedMsg = liveMsg as unknown as AudioTranscriptExtended;
              const modelTranscript = extendedMsg.outputAudioTranscription?.text;
              const userTranscript = extendedMsg.inputAudioTranscription?.text;
              
              if (userTranscript) {
                const userLog: LogEntry = {
                  id: 'usr_' + Math.random().toString(36).substring(2, 9),
                  timestamp: new Date().toLocaleTimeString(),
                  role: 'user',
                  text: userTranscript
                };
                transcriptionLogs.unshift(userLog);
                if (transcriptionLogs.length > 100) transcriptionLogs.pop();
                broadcastToClients({ type: 'transcription-added', log: userLog });
              }
              
              if (modelTranscript || partText) {
                if (liveMsg.serverContent?.turnComplete) {
                  const finalModelText = modelTranscript || partText;
                  const modelLog: LogEntry = {
                    id: 'mod_' + Math.random().toString(36).substring(2, 9),
                    timestamp: new Date().toLocaleTimeString(),
                    role: 'model',
                    text: finalModelText
                  };
                  transcriptionLogs.unshift(modelLog);
                  if (transcriptionLogs.length > 100) transcriptionLogs.pop();
                  broadcastToClients({ type: 'transcription-added', log: modelLog });
                }
              }
              
              if (liveMsg.serverContent?.interrupted) {
                clientWs.send(JSON.stringify({ type: 'interrupted' }));
              }
            }
          },
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: payload.voice || 'Zephyr' // Puck, Charon, Kore, Fenrir, Zephyr
                }
              }
            },
            systemInstruction: payload.systemInstruction || `You are 'Aria', an elite financial market analyst AI guide. Talk clearly, concisely, and fast about tickers AAPL, GOOGL, TSLA, MSFT, BTC, ETH. Provide strategic inputs. Keep simulations educational first.`,
            outputAudioTranscription: {},
            inputAudioTranscription: {},
          }
        });
        
        geminiSession = sessionConn as unknown as GeminiLiveSession;
        clientWs.send(JSON.stringify({ type: 'session-active' }));
      }
      
      else if (payload.type === 'audio-input') {
        if (geminiSession) {
          geminiSession.sendRealtimeInput({
            audio: { data: payload.data, mimeType: payload.mimeType || 'audio/pcm;rate=16000' }
          });
        }
      }
      
      else if (payload.type === 'text-input') {
        if (geminiSession) {
          // Send manual query text to AI assistant session
          geminiSession.sendRealtimeInput({
            text: payload.text
          });
          
          // Log manual user queries immediately
          const userLog: LogEntry = {
            id: 'usr_' + Math.random().toString(36).substring(2, 9),
            timestamp: new Date().toLocaleTimeString(),
            role: 'user',
            text: payload.text
          };
          transcriptionLogs.unshift(userLog);
          if (transcriptionLogs.length > 100) transcriptionLogs.pop();
          broadcastToClients({ type: 'transcription-added', log: userLog });
        }
      }
      
      else if (payload.type === 'stop-session') {
        if (geminiSession) {
          geminiSession.close();
          geminiSession = null;
          clientWs.send(JSON.stringify({ type: 'session-inactive' }));
        }
      }
      
      else if (payload.type === 'create-alert-rule') {
        const { symbol, condition, targetPrice } = payload;
        const wsInst = clientWs as CustomWebSocket;
        wsInst.alertRules = wsInst.alertRules || [];
        wsInst.alertRules.push({ symbol, condition, targetPrice: Number(targetPrice), triggered: false });
        clientWs.send(JSON.stringify({ type: 'notification-ack', message: `Dynamic notification trigger configured for ${symbol} when price resolves ${condition} $${targetPrice}.` }));
      }
      
      else if (payload.type === 'clear-alert-rules') {
        (clientWs as CustomWebSocket).alertRules = [];
        clientWs.send(JSON.stringify({ type: 'notification-ack', message: `All active price threshold trigger bounds erased.` }));
      }
      
    } catch (wsErr) {
      console.error('Error handling WebSocket message on server API loop:', wsErr);
    }
  });

  clientWs.on('close', () => {
    activeClients.delete(clientWs);
    console.log('CLIENT DISCONNECTED from Financial Live API service.');
    if (geminiSession) {
      geminiSession.close();
      geminiSession = null;
    }
  });
});

// Primary real-time simulation interval (Ticks every 2 seconds)
setInterval(() => {
  updateTickerPrices();
  checkStrategyTriggers();
  
  // Distribute active pricing state updates to clients
  broadcastToClients({ type: 'market-data-tick', tickers });
  
  // Sweep client threshold alert matches
  wss.clients.forEach(client => {
    const rules = (client as CustomWebSocket).alertRules;
    if (rules && rules.length > 0) {
      rules.forEach((rule) => {
        if (rule.triggered) return;
        
        const currentTickerObj = tickers.find(t => t.symbol === rule.symbol);
        if (currentTickerObj) {
          let hasFiredState = false;
          if (rule.condition === 'above' && currentTickerObj.price >= rule.targetPrice) {
            hasFiredState = true;
          } else if (rule.condition === 'below' && currentTickerObj.price <= rule.targetPrice) {
            hasFiredState = true;
          }
          
          if (hasFiredState) {
            rule.triggered = true;
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'alert-triggered',
                alert: {
                  symbol: rule.symbol,
                  condition: rule.condition,
                  targetPrice: rule.targetPrice,
                  currentPrice: currentTickerObj.price,
                  text: `🔔 PUSH ALERT TRIGGERED: ${rule.symbol} moved ${rule.condition} $${rule.targetPrice} (Current Value: $${currentTickerObj.price}). Evaluational strategy advises review of asset holdings.`
                }
              }));
            }
          }
        }
      });
    }
  });
}, 2000);

if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 3000;
  server.listen(port, () => {
    console.log(`Server orchestration engine on http://localhost:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
