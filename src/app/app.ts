/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  signal,
  inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

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

interface StrategySuggestion {
  id: string;
  ticker: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  strategyName: string;
  price: number;
  reason: string;
  timestamp: string;
}

interface LogEntry {
  id: string;
  timestamp: string;
  role: 'user' | 'model';
  text: string;
}

interface AlertRule {
  symbol: string;
  condition: 'above' | 'below';
  targetPrice: number;
  triggered: boolean;
}

@Component({
  selector: 'app-root',
  imports: [CommonModule, ReactiveFormsModule, MatIconModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit, OnDestroy {
  private fb = inject(FormBuilder);

  // Layout View Tabs
  activeTab = signal<'dashboard' | 'strategies' | 'logs' | 'settings'>('dashboard');

  // Interactive configurations
  selectedVoice = signal<string>('Zephyr');
  autonomousOutput = signal<boolean>(true); // Audio reading outloud enabled
  audioGain = signal<number>(0.8);
  inputStreamMode = signal<'ptt' | 'live'>('live'); // Always-On Mic vs PTT

  // Core Connection States
  webSocketStatus = signal<'disconnected' | 'connecting' | 'connected'>('disconnected');
  aiSessionStatus = signal<'inactive' | 'activating' | 'active'>('inactive');
  isMicRecording = signal<boolean>(false);
  errorMessage = signal<string | null>(null);

  // Asset selection
  selectedTickerSymbol = signal<string>('BTC-USD');
  tickersList = signal<MarketTicker[]>([]);
  strategySuggestionsList = signal<StrategySuggestion[]>([]);
  transcriptionLogsList = signal<LogEntry[]>([]);
  activeAlertRules = signal<AlertRule[]>([]);
  
  // Custom toast notifications for visual/audio alerts
  toastsList = signal<{ id: string; text: string; timestamp: string }[]>([]);

  // Search parameters
  logSearchQuery = signal<string>('');

  // Forms
  alertForm!: FormGroup;

  protected readonly Math = Math;

  // Web Sockets and Audio Refs
  private socket: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private nextStartTime = 0;
  protected audioSources: AudioBufferSourceNode[] = [];
  
  // Microphone capturing nodes
  private micStream: MediaStream | null = null;
  private audioProcessor: ScriptProcessorNode | null = null;
  private inputAudioContext: AudioContext | null = null;

  @ViewChild('logContainer') private logContainer!: ElementRef;

  // Dynamic SVG Chart Coordinates calculated via computed signals
  currentPoints = computed(() => {
    const currentSymbol = this.selectedTickerSymbol();
    const list = this.tickersList();
    const ticker = list.find(t => t.symbol === currentSymbol);
    
    if (!ticker || !ticker.prices || ticker.prices.length === 0) {
      return {
        pricePath: '',
        areaPath: '',
        smaPath: '',
        upperPath: '',
        lowerPath: '',
        ticks: [] as { x: number; y: number; price: number }[]
      };
    }
    
    const width = 680;
    const height = 280;
    const padding = 12;
    const prices = ticker.prices;
    
    // Add active live price to coordinates
    const pricesToDraw = [...prices];
    if (pricesToDraw[pricesToDraw.length - 1] !== ticker.price) {
      pricesToDraw.push(ticker.price);
    }
    
    // Determine bounds
    const minPrice = Math.min(...pricesToDraw, ticker.lowerBand) * 0.9995;
    const maxPrice = Math.max(...pricesToDraw, ticker.upperBand) * 1.0005;
    const priceRange = maxPrice - minPrice || 1;
    const length = pricesToDraw.length;
    
    const points = pricesToDraw.map((price, idx) => {
      const x = padding + (idx / (length - 1)) * (width - 2 * padding);
      const y = height - padding - ((price - minPrice) / priceRange) * (height - 2 * padding);
      return { x, y, price };
    });
    
    const pricePath = points.map((p, idx) => (idx === 0 ? `M ` : `L `) + `${p.x},${p.y}`).join(' ');
    const areaPath = pricePath + ` L ${points[points.length - 1].x},${height} L ${points[0].x},${height} Z`;
    
    // SMA indicator line height
    const smaVal = ticker.sma;
    const smaY = height - padding - ((smaVal - minPrice) / priceRange) * (height - 2 * padding);
    const smaPath = `M ${padding},${smaY} L ${width - padding},${smaY}`;
    
    // Bollinger Upper Band line height
    const upperVal = ticker.upperBand;
    const upperY = height - padding - ((upperVal - minPrice) / priceRange) * (height - 2 * padding);
    const upperPath = `M ${padding},${upperY} L ${width - padding},${upperY}`;
    
    // Bollinger Lower Band line height
    const lowerVal = ticker.lowerBand;
    const lowerY = height - padding - ((lowerVal - minPrice) / priceRange) * (height - 2 * padding);
    const lowerPath = `M ${padding},${lowerY} L ${width - padding},${lowerY}`;
    
    return {
      pricePath,
      areaPath,
      smaPath,
      upperPath,
      lowerPath,
      ticks: points
    };
  });

  // Highlight metrics for currently selected stock
  selectedTickerData = computed(() => {
    const list = this.tickersList();
    const symbol = this.selectedTickerSymbol();
    return list.find(t => t.symbol === symbol) || null;
  });

  // Searches logs
  filteredTranscriptionLogs = computed(() => {
    const logs = this.transcriptionLogsList();
    const query = this.logSearchQuery().toLowerCase().trim();
    if (!query) return logs;
    return logs.filter(l => l.text.toLowerCase().includes(query));
  });

  ngOnInit() {
    this.initForms();
    this.requestNotificationPermissions();
    this.connectLiveWebSocket();
  }

  ngOnDestroy() {
    this.stopMicrophoneCapture();
    this.stopAllSpeech();
    if (this.socket) {
      this.socket.close();
    }
  }

  initForms() {
    this.alertForm = this.fb.group({
      symbol: ['BTC-USD', Validators.required],
      condition: ['above', Validators.required],
      targetPrice: ['', [Validators.required, Validators.min(0.01)]]
    });
  }

  requestNotificationPermissions() {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
        Notification.requestPermission();
      }
    }
  }

  /**
   * Primary WebSocket handshaking & network orchestration helper
   */
  connectLiveWebSocket() {
    if (typeof window === 'undefined') {
      return;
    }
    this.webSocketStatus.set('connecting');
    this.errorMessage.set(null);
    
    // Build production connection endpoint
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const socketUrl = `${protocol}//${host}/api/live-ws`;
    
    try {
      this.socket = new WebSocket(socketUrl);
      
      this.socket.onopen = () => {
        this.webSocketStatus.set('connected');
        console.log('WS network socket successfully established.');
      };
      
      this.socket.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        this.handleServerMessage(payload);
      };
      
      this.socket.onclose = () => {
        this.webSocketStatus.set('disconnected');
        this.aiSessionStatus.set('inactive');
        this.isMicRecording.set(false);
        console.log('WS network connection shut down.');
      };
      
      this.socket.onerror = (err) => {
        this.webSocketStatus.set('disconnected');
        this.errorMessage.set('WebSocket server connection fault occurred. Restoring network gateway...');
        console.error('WS Connection failure:', err);
      };
      
    } catch (wsSetupError) {
      this.webSocketStatus.set('disconnected');
      this.errorMessage.set('Could not initialize network socket bridge.');
      console.error(wsSetupError);
    }
  }

  /**
   * Parse events from the backend Financial/Gemini Live server
   */
  handleServerMessage(payload: any) {
    if (payload.type === 'market-data-tick') {
      this.tickersList.set(payload.tickers);
    }
    
    else if (payload.type === 'history-suggestions') {
      this.strategySuggestionsList.set(payload.suggestions);
    }
    
    else if (payload.type === 'strategy-suggestion') {
      this.strategySuggestionsList.update(list => {
        const updated = [payload.suggestion, ...list];
        return updated.slice(0, 100);
      });
      this.triggerAlertNotify('Automated Strategy Indicator', `${payload.suggestion.ticker}: ${payload.suggestion.strategyName} (${payload.suggestion.action})`);
      
      // Auto speech analysis if outloud mode active and dashboard or tab is visible
      if (this.autonomousOutput()) {
        this.speakOutloudText(`System generated automated strategy suggestion for ${payload.suggestion.ticker}. ${payload.suggestion.strategyName} with signal ${payload.suggestion.action}. Reason: ${payload.suggestion.reason}`);
      }
    }
    
    else if (payload.type === 'history-logs') {
      this.transcriptionLogsList.set(payload.logs);
    }
    
    else if (payload.type === 'transcription-added') {
      this.transcriptionLogsList.update(list => {
        const index = list.findIndex(l => l.id === payload.log.id);
        if (index > -1) return list;
        const updated = [payload.log, ...list];
        return updated.slice(0, 100);
      });
      setTimeout(() => this.scrollToBottomLogs(), 100);
    }
    
    else if (payload.type === 'gemini-audio') {
      this.playPCMNoiseChunk(payload.data);
    }
    
    else if (payload.type === 'text-output') {
      // Streamed model character blocks
    }
    
    else if (payload.type === 'interrupted') {
      console.log('User interjected speech. Interrupting model voice pipeline instantly...');
      this.stopAllSpeech();
    }
    
    else if (payload.type === 'session-active') {
      this.aiSessionStatus.set('active');
      this.errorMessage.set(null);
      
      // Start microphone recording automated loop if Live Mic mode is chosen
      if (this.inputStreamMode() === 'live') {
        this.startMicrophoneCapture();
      }
    }
    
    else if (payload.type === 'session-inactive') {
      this.aiSessionStatus.set('inactive');
      this.stopMicrophoneCapture();
    }
    
    else if (payload.type === 'alert-triggered') {
      this.triggerAlertNotify('🚨 Price Threshold Squeeze Alert', payload.alert.text);
      
      // Flash speaking trigger outloud for user warning
      if (this.autonomousOutput()) {
        this.speakOutloudText(`Emergency Alert. Selected target priced condition hit for ${payload.alert.symbol}. Alert context reads: ${payload.alert.text}`);
      }
    }
    
    else if (payload.type === 'notification-ack') {
      this.addVisualToast(payload.message);
    }
    
    else if (payload.type === 'error') {
      this.errorMessage.set(payload.message);
      this.aiSessionStatus.set('inactive');
      this.stopMicrophoneCapture();
    }
  }

  /**
   * Gemini Live Session Activation
   */
  startAIPortationSession() {
    if (!this.socket || this.webSocketStatus() !== 'connected') {
      this.errorMessage.set('WebSocket link not active. Instigating network reconnect...');
      this.connectLiveWebSocket();
      return;
    }
    
    this.aiSessionStatus.set('activating');
    
    const selectedAsset = this.selectedTickerData();
    const tickerContext = selectedAsset ? 
      `The user is currently auditing ticker ${selectedAsset.name} (${selectedAsset.symbol}) trading at $${selectedAsset.price}. Technics include: RSI is ${selectedAsset.rsi}, SMA is $${selectedAsset.sma}, Bollinger parameters configured Upper $${selectedAsset.upperBand} & Lower $${selectedAsset.lowerBand}.` : '';

    const instruction = `You are 'Aria', an elite voice-controlled AI Portfolio Strategist & Market Specialist on real-time financial simulated asset pairs. Talk concisely, in a highly professional, clinical, helpful technical manager style. Guide user queries. Let them interact hands-free. Keep briefings directly to-the-point under 25 words. Ask quick directional followups. ${tickerContext}`;
    
    this.socket.send(JSON.stringify({
      type: 'start-session',
      voice: this.selectedVoice(),
      systemInstruction: instruction
    }));
  }

  stopAIPortationSession() {
    if (this.socket && this.webSocketStatus() === 'connected') {
      this.socket.send(JSON.stringify({ type: 'stop-session' }));
    }
    this.stopMicrophoneCapture();
    this.stopAllSpeech();
    this.aiSessionStatus.set('inactive');
  }

  /**
   * User Text Query Transmission
   */
  sendQueryMessage(textInput: HTMLInputElement) {
    const val = textInput.value.trim();
    if (!val) return;
    
    if (this.aiSessionStatus() !== 'active') {
      this.errorMessage.set('Voice session is offline. Initialize Aria to send manual inquiries.');
      return;
    }
    
    if (this.socket && this.webSocketStatus() === 'connected') {
      this.socket.send(JSON.stringify({
        type: 'text-input',
        text: val
      }));
      textInput.value = '';
    }
  }

  /**
   * Client-Side Audio Out-loud synthesis fallback or automated readings (using Web Speech API Synthesis as fallback)
   */
  speakOutloudText(textToRead: string) {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.stopAllSpeech();
      const utterance = new SpeechSynthesisUtterance(textToRead.slice(0, 300));
      utterance.rate = 1.05;
      utterance.volume = this.audioGain();
      window.speechSynthesis.speak(utterance);
    }
  }

  /**
   * Browser Push Notifications + Audio beeping alerts implementation
   */
  triggerAlertNotify(title: string, bodyText: string) {
    // 1. Desktop Notification
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(title, {
        body: bodyText,
        icon: '/favicon.ico'
      });
    }
    
    // 2. Play warning alert beep based on settings audio context
    try {
      const beepContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = beepContext.createOscillator();
      const gain = beepContext.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(620, beepContext.currentTime); // Professional alert frequency
      gain.gain.setValueAtTime(0.2 * this.audioGain(), beepContext.currentTime);
      
      osc.connect(gain);
      gain.connect(beepContext.destination);
      
      osc.start();
      osc.stop(beepContext.currentTime + 0.18);
    } catch (soundErr) {
      console.log('Audio Alert beep fail:', soundErr);
    }
    
    // 3. Inline visual alert panel
    this.addVisualToast(bodyText);
  }

  addVisualToast(messageStr: string) {
    const newAlert = {
      id: Math.random().toString(36).substring(2, 9),
      text: messageStr,
      timestamp: new Date().toLocaleTimeString()
    };
    
    this.toastsList.update(list => [newAlert, ...list]);
    
    // Auto purge toast after 8 seconds
    setTimeout(() => {
      this.toastsList.update(list => list.filter(t => t.id !== newAlert.id));
    }, 8000);
  }

  removeToast(id: string) {
    this.toastsList.update(list => list.filter(t => t.id !== id));
  }

  /**
   * Client Alert Rule submission
   */
  submitAlertConfig() {
    if (!this.alertForm.valid) return;
    
    if (this.socket && this.webSocketStatus() === 'connected') {
      const rawPayload = this.alertForm.value;
      
      // Propagate rule triggers registration down to backend
      this.socket.send(JSON.stringify({
        type: 'create-alert-rule',
        symbol: rawPayload.symbol,
        condition: rawPayload.condition,
        targetPrice: rawPayload.targetPrice
      }));
      
      this.activeAlertRules.update(list => [
        {
          symbol: rawPayload.symbol,
          condition: rawPayload.condition,
          targetPrice: Number(rawPayload.targetPrice),
          triggered: false
        },
        ...list
      ]);
      
      this.alertForm.get('targetPrice')?.reset();
    } else {
      this.errorMessage.set('WebSocket offline. ALERT could not be integrated.');
    }
  }

  clearAlertRules() {
    if (this.socket && this.webSocketStatus() === 'connected') {
      this.socket.send(JSON.stringify({ type: 'clear-alert-rules' }));
    }
    this.activeAlertRules.set([]);
  }

  /**
   * Local Voice presets setup on-the-fly inside setting triggers
   */
  setVoiceSetting(voiceStr: string) {
    this.selectedVoice.set(voiceStr);
    this.addVisualToast(`Core advisor voice configured to '${voiceStr}'. Reboot session to lock configuration.`);
    if (this.aiSessionStatus() === 'active') {
      // Hot reload session
      this.stopAIPortationSession();
      setTimeout(() => this.startAIPortationSession(), 600);
    }
  }

  /**
   * Client-Side Microphone capturing algorithm
   */
  async startMicrophoneCapture() {
    try {
      this.stopMicrophoneCapture();
      
      this.inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const srcNode = this.inputAudioContext.createMediaStreamSource(this.micStream);
      
      // 4096 stream buffer rate
      this.audioProcessor = this.inputAudioContext.createScriptProcessor(4096, 1, 1);
      
      srcNode.connect(this.audioProcessor);
      this.audioProcessor.connect(this.inputAudioContext.destination);
      
      this.isMicRecording.set(true);
      
      this.audioProcessor.onaudioprocess = (e) => {
        if (!this.socket || this.webSocketStatus() !== 'connected') return;
        
        const rawInputBuffer = e.inputBuffer.getChannelData(0);
        const bufferLen = rawInputBuffer.length;
        const int16Array = new Int16Array(bufferLen);
        
        for (let i = 0; i < bufferLen; i++) {
          const clampedVal = Math.max(-1, Math.min(1, rawInputBuffer[i]));
          int16Array[i] = clampedVal < 0 ? clampedVal * 0x8000 : clampedVal * 0x7FFF;
        }
        
        const byteBufferBytes = new Uint8Array(int16Array.buffer);
        let binStr = '';
        const byteLen = byteBufferBytes.byteLength;
        for (let i = 0; i < byteLen; i++) {
          binStr += String.fromCharCode(byteBufferBytes[i]);
        }
        const b64Data = window.btoa(binStr);
        
        this.socket.send(JSON.stringify({
          type: 'audio-input',
          data: b64Data,
          mimeType: 'audio/pcm;rate=16000'
        }));
      };
      
    } catch (mediaError) {
      this.errorMessage.set('Permission to access Microphone device was rejected. Conversational Speech disabled.');
      this.isMicRecording.set(false);
      console.error('Microphone capture fail:', mediaError);
    }
  }

  stopMicrophoneCapture() {
    this.isMicRecording.set(false);
    if (this.audioProcessor) {
      this.audioProcessor.disconnect();
      this.audioProcessor = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach(track => track.stop());
      this.micStream = null;
    }
    if (this.inputAudioContext) {
      this.inputAudioContext.close();
      this.inputAudioContext = null;
    }
  }

  /**
   * Client-Side Web Audio raw PCM chunks playback scheduling scheduler
   */
  playPCMNoiseChunk(base64Payload: string) {
    if (!this.autonomousOutput()) return;
    
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        this.nextStartTime = this.audioCtx.currentTime;
      }
      
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      
      const rawBinary = window.atob(base64Payload);
      const binLength = rawBinary.length;
      const decBytes = new Uint8Array(binLength);
      
      for (let i = 0; i < binLength; i++) {
        decBytes[i] = rawBinary.charCodeAt(i);
      }
      
      const int16Buf = new Int16Array(decBytes.buffer);
      const float32Output = new Float32Array(int16Buf.length);
      
      for (let i = 0; i < int16Buf.length; i++) {
        float32Output[i] = int16Buf[i] / 32768.0;
      }
      
      const playBuf = this.audioCtx.createBuffer(1, float32Output.length, 24000);
      playBuf.getChannelData(0).set(float32Output);
      
      const sourceNode = this.audioCtx.createBufferSource();
      sourceNode.buffer = playBuf;
      
      // Control volume gain parameter
      const nodeGain = this.audioCtx.createGain();
      nodeGain.gain.value = this.audioGain();
      
      sourceNode.connect(nodeGain);
      nodeGain.connect(this.audioCtx.destination);
      
      this.audioSources.push(sourceNode);
      
      const currentContextClock = this.audioCtx.currentTime;
      if (this.nextStartTime < currentContextClock) {
        this.nextStartTime = currentContextClock;
      }
      
      sourceNode.start(this.nextStartTime);
      this.nextStartTime += playBuf.duration;
      
    } catch (audioPlayerError) {
      console.log('Audio PCM synthesis stream failure:', audioPlayerError);
    }
  }

  stopAllSpeech() {
    this.audioSources.forEach(s => {
      try { s.stop(); } catch (e) { console.debug(e); }
    });
    this.audioSources = [];
    this.nextStartTime = this.audioCtx ? this.audioCtx.currentTime : 0;
    
    // Standard Speech Engine cancel fallback
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  // Visual Asset switching
  selectVisualAsset(symbol: string) {
    this.selectedTickerSymbol.set(symbol);
    this.alertForm.patchValue({ symbol });
    
    // Notify AI core of focus switch if active
    if (this.aiSessionStatus() === 'active' && this.socket) {
      this.socket.send(JSON.stringify({
        type: 'text-input',
        text: `Auditing dynamic statistics of asset ${symbol} active chart now. Provide a brief tech commentary.`
      }));
    }
  }

  private scrollToBottomLogs() {
    try {
      if (this.logContainer) {
        const el = this.logContainer.nativeElement;
        el.scrollTop = el.scrollHeight;
      }
    } catch (err) { console.debug(err); }
  }
}
