import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  BatteryFull, ChevronDown, Palette, Command, FileText, Globe2, Minus,
  Music2, Search, ShieldCheck, TerminalSquare, Wifi, X, Maximize2, Minimize2, RotateCcw,
} from 'lucide-react';
import type { HandInputRef } from '../vision/types';
import { AirHandCursorSmoother } from '../vision/airHandEngine';

type WindowId = 'browser' | 'notes' | 'terminal' | 'music';
type AirWindow = { id: WindowId; x: number; y: number; z: number; minimized: boolean; closed: boolean };
type DragState = { id: WindowId; startX: number; startY: number; originX: number; originY: number; source: 'pointer' | 'gesture' };

const initialWindows: AirWindow[] = [
  { id: 'browser', x: 4, y: 9, z: 2, minimized: false, closed: false },
  { id: 'notes', x: 51, y: 10, z: 3, minimized: false, closed: false },
  { id: 'terminal', x: 13, y: 46, z: 4, minimized: false, closed: false },
  { id: 'music', x: 59, y: 48, z: 1, minimized: false, closed: false },
];
const titles: Record<WindowId, string> = {
  browser: 'Nexus Browser', notes: 'Quick Notes', terminal: 'Terminal', music: 'Ambient Player',
};
const icons = { browser: Globe2, notes: FileText, terminal: TerminalSquare, music: Music2 };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

type Props = { inputRef: HandInputRef; cameraEnabled: boolean };

export default function AirOSDesktop({ inputRef, cameraEnabled }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const lastPinchRef = useRef(false);
  const lastGesturePositionRef = useRef({ x: Number.NaN, y: Number.NaN });
  const smoothedHandPositionRef = useRef(new AirHandCursorSmoother());
  const cameraRef = useRef(cameraEnabled);
  const windowsRef = useRef(initialWindows);
  const topZRef = useRef(5);
  const audioContextRef = useRef<AudioContext | null>(null);
  const oscillatorRef = useRef<OscillatorNode | null>(null);
  const lfoRef = useRef<OscillatorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const [windows, setWindows] = useState<AirWindow[]>(initialWindows);
  const [note, setNote] = useState(() => {
    try { return localStorage.getItem('nexus-air-note') ?? 'Ideas for the next build…'; }
    catch { return 'Ideas for the next build…'; }
  });
  const [address, setAddress] = useState('nexus://welcome');
  const [searchText, setSearchText] = useState('');
  const [terminalCommand, setTerminalCommand] = useState('');
  const [terminalOutput, setTerminalOutput] = useState<string[]>(['NEXUS TERMINAL 0.1', 'Type help to see demo commands.']);
  const [playing, setPlaying] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [maximizedWindow, setMaximizedWindow] = useState<WindowId | null>(null);
  const [showLauncher, setShowLauncher] = useState(false);
  cameraRef.current = cameraEnabled;
  windowsRef.current = windows;

  const moveWindow = (id: WindowId, x: number, y: number) => {
    setWindows((current) => current.map((item) => item.id === id
      ? { ...item, x: clamp(x, 0, 78), y: clamp(y, 0, 70) }
      : item));
  };

  const focusWindow = (id: WindowId) => {
    topZRef.current += 1;
    setWindows((current) => current.map((item) => item.id === id ? { ...item, z: topZRef.current } : item));
  };

  const openWindow = (id: WindowId) => {
    topZRef.current += 1;
    setWindows((current) => current.map((item) => item.id === id
      ? { ...item, z: topZRef.current, minimized: false, closed: false }
      : item));
    setShowLauncher(false);
  };

  const startPointerDrag = (event: ReactPointerEvent<HTMLElement>, id: WindowId) => {
    if ((event.target as HTMLElement).closest('button')) return;
    const host = hostRef.current;
    const windowModel = windowsRef.current.find((item) => item.id === id);
    if (!host || !windowModel) return;
    event.preventDefault();
    focusWindow(id);
    dragRef.current = {
      id, startX: event.clientX, startY: event.clientY,
      originX: windowModel.x, originY: windowModel.y, source: 'pointer',
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const runCommand = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const command = terminalCommand.trim();
    if (!command) return;
    let output: string;
    switch (command.toLowerCase()) {
      case 'help': output = 'Commands: help, date, whoami, clear, ls'; break;
      case 'date': output = new Date().toString(); break;
      case 'whoami': output = 'guest@nexus · browser sandbox'; break;
      case 'ls': output = 'Desktop/  Notes/  Projects/  Readme.md'; break;
      case 'clear': setTerminalOutput([]); setTerminalCommand(''); return;
      default: output = command + ': command not found (demo terminal only)';
    }
    setTerminalOutput((current) => [...current, '$ ' + command, output].slice(-8));
    setTerminalCommand('');
  };

  const stopAmbient = () => {
    try { oscillatorRef.current?.stop(); } catch { /* already stopped */ }
    try { lfoRef.current?.stop(); } catch { /* already stopped */ }
    gainRef.current = null;
    oscillatorRef.current = null;
    lfoRef.current = null;
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') void audioContextRef.current.close();
    audioContextRef.current = null;
    setPlaying(false);
  };

  const toggleAmbient = async () => {
    if (playing) {
      stopAmbient();
      return;
    }
    try {
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const lfo = audio.createOscillator();
      const lfoGain = audio.createGain();
      const gain = audio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = 110;
      lfo.type = 'sine';
      lfo.frequency.value = 0.16;
      lfoGain.gain.value = 7;
      gain.gain.value = 0.018;
      lfo.connect(lfoGain);
      lfoGain.connect(oscillator.frequency);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start();
      lfo.start();
      await audio.resume();
      audioContextRef.current = audio;
      oscillatorRef.current = oscillator;
      lfoRef.current = lfo;
      gainRef.current = gain;
      setPlaying(true);
    } catch {
      stopAmbient();
    }
  };

  useEffect(() => {
    try { localStorage.setItem('nexus-air-note', note); } catch { /* private mode can disable storage */ }
  }, [note]);

  useEffect(() => {
    const interval = window.setInterval(() => setClock(new Date()), 15000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    const movePointer = (clientX: number, clientY: number, drag: DragState) => {
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      moveWindow(drag.id,
        drag.originX + ((clientX - drag.startX) / rect.width) * 100,
        drag.originY + ((clientY - drag.startY) / rect.height) * 100);
    };
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag?.source === 'pointer') movePointer(event.clientX, event.clientY, drag);
    };
    const onPointerUp = () => {
      if (dragRef.current?.source === 'pointer') dragRef.current = null;
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    const tick = () => {
      if (!hostRef.current || !cursorRef.current) {
        frame = requestAnimationFrame(tick);
        return;
      }
      const hand = cameraRef.current ? inputRef.current : null;
      const cursor = cursorRef.current;
      const detected = Boolean(hand?.detected);
      cursor.style.visibility = detected ? 'visible' : 'hidden';
      if (detected && hand) {
        const smooth = smoothedHandPositionRef.current.update(hand.x, hand.y, performance.now());
        cursor.style.left = (smooth.x * 100) + '%';
        cursor.style.top = (smooth.y * 100) + '%';
        cursor.classList.toggle('air-cursor-pinching', hand.pinch);
        const rect = host.getBoundingClientRect();
        const screenX = rect.left + smooth.x * rect.width;
        const screenY = rect.top + smooth.y * rect.height;
        if (hand.pinch && !lastPinchRef.current) {
          const hit = document.elementFromPoint(screenX, screenY)?.closest<HTMLElement>('[data-air-window-title]');
          const id = hit?.dataset.airWindowTitle as WindowId | undefined;
          const model = id ? windowsRef.current.find((item) => item.id === id && !item.closed && !item.minimized) : undefined;
          if (id && model) {
            topZRef.current += 1;
            focusWindow(id);
            dragRef.current = { id, startX: screenX, startY: screenY, originX: model.x, originY: model.y, source: 'gesture' };
            lastGesturePositionRef.current = { x: screenX, y: screenY };
            lastGesturePositionRef.current = { x: screenX, y: screenY };
          }
        }
        if (hand.pinch && dragRef.current?.source === 'gesture') {
          const last = lastGesturePositionRef.current;
          if (Math.abs(screenX - last.x) > 2.5 || Math.abs(screenY - last.y) > 2.5) {
            movePointer(screenX, screenY, dragRef.current);
            lastGesturePositionRef.current = { x: screenX, y: screenY };
          }
        }
        if (!hand.pinch && lastPinchRef.current && dragRef.current?.source === 'gesture') {
          dragRef.current = null;
          lastGesturePositionRef.current = { x: Number.NaN, y: Number.NaN };
        }
        lastPinchRef.current = hand.pinch;
      } else {
        cursor.classList.remove('air-cursor-pinching');
        if (lastPinchRef.current && dragRef.current?.source === 'gesture') {
          dragRef.current = null;
          lastGesturePositionRef.current = { x: Number.NaN, y: Number.NaN };
        }
        lastPinchRef.current = false;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
    // Mutable refs deliberately carry real-time tracking state without forcing render loops.
  }, [inputRef]);

  useEffect(() => () => {
    try { oscillatorRef.current?.stop(); } catch { /* already stopped */ }
    try { lfoRef.current?.stop(); } catch { /* already stopped */ }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') void audioContextRef.current.close();
  }, []);

  const activeWindows = windows.filter((item) => !item.closed && !item.minimized);

  return (
    <div ref={hostRef} className={'air-os-layer ' + theme} aria-label="Nexus gesture-controlled desktop">
      <div className="air-os-wallpaper" />
      <div className="air-os-menubar">
        <span className="air-os-logo"><Command size={14} /> NEXUS</span>
        <span className="air-os-activeapp"><ChevronDown size={12} /> Workspace</span>
        <span className="air-os-menuright"><ShieldCheck size={13} /> LOCAL SESSION <Wifi size={13} /><BatteryFull size={15} /></span>
      </div>
      <div className="air-os-date"><strong>{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong><span>{clock.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span></div>

      {activeWindows.map((item) => {
        const WindowIcon = icons[item.id];
        return (
          <section key={item.id} data-air-window={item.id} className={'air-window air-window-' + item.id + (maximizedWindow === item.id ? ' air-window-maximized' : '')} style={maximizedWindow === item.id ? { zIndex: item.z } : { left: item.x + '%', top: item.y + '%', zIndex: item.z }} onPointerDown={() => focusWindow(item.id)}>
            <header className="air-window-title" data-air-window-title={item.id} onPointerDown={(event) => { if (maximizedWindow !== item.id) startPointerDrag(event, item.id); }}>
              <div className="air-window-lights">
                <button aria-label={'Close ' + titles[item.id]} onClick={() => setWindows((current) => current.map((entry) => entry.id === item.id ? { ...entry, closed: true } : entry))}><X size={9} /></button>
                <button aria-label={'Minimize ' + titles[item.id]} onClick={() => setWindows((current) => current.map((entry) => entry.id === item.id ? { ...entry, minimized: true } : entry))}><Minus size={9} /></button>
                <span />
              </div>
              <WindowIcon size={12} />
              <span>{titles[item.id]}</span>
              <span className="air-window-spacer" />
              <button className="air-window-action" aria-label={maximizedWindow === item.id ? 'Restore window' : 'Maximize window'} onClick={() => setMaximizedWindow(maximizedWindow === item.id ? null : item.id)}>{maximizedWindow === item.id ? <Minimize2 size={12} /> : <Maximize2 size={12} />}</button>
            </header>
            {item.id === 'browser' && <div className="air-app-body browser-body">
              <div className="browser-address"><ShieldCheck size={12} /><input value={address} onChange={(event) => setAddress(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') setAddress(event.currentTarget.value.trim() || 'nexus://welcome'); }} aria-label="Demo browser address" /><button onClick={() => setAddress('nexus://welcome')} aria-label="Go to welcome page"><Search size={12} /></button></div>
              <div className="browser-welcome"><span className="browser-eyebrow">NEXUS WEB SPACE</span><h3>{address === 'nexus://welcome' ? 'A space of your own.' : 'Ready to explore?'}</h3><p>{address === 'nexus://welcome' ? 'Your ideas, your tools, your flow.' : 'This preview keeps navigation inside the demo workspace.'}</p><button onClick={() => setSearchText(searchText ? '' : 'Explore gesture controls')}>{searchText || 'Explore workspace'} <ChevronDown size={12} /></button>{searchText && <small className="browser-search-result">Try HoloDesk, ShadowStrike, AirOS, or RealityScan from Nexus home.</small>}</div>
            </div>}
            {item.id === 'notes' && <div className="air-app-body notes-body"><div className="notes-bar"><span>PERSONAL NOTE</span><span>LOCAL</span></div><textarea value={note} onChange={(event) => setNote(event.target.value)} aria-label="Quick note" placeholder="Write an idea…" /><div className="notes-footer"><ShieldCheck size={11} /> Saved on this device</div></div>}
            {item.id === 'terminal' && <div className="air-app-body terminal-body"><div className="terminal-output">{terminalOutput.map((line, index) => <div key={index} className={line.startsWith('$') ? 'terminal-command' : ''}>{line}</div>)}</div><form className="terminal-form" onSubmit={runCommand}><span>$</span><input value={terminalCommand} onChange={(event) => setTerminalCommand(event.target.value)} aria-label="Demo terminal command" placeholder="type help…" autoComplete="off" /><button aria-label="Run demo command" type="submit"><ChevronDown size={12} /></button></form><div className="terminal-safety">SIMULATED SHELL · NO SYSTEM COMMANDS EXECUTE</div></div>}
            {item.id === 'music' && <div className="air-app-body music-body"><div className="music-art"><div className="music-orbit orbit-a" /><div className="music-orbit orbit-b" /><div className="music-core"><Music2 size={23} /></div></div><span className="music-track-title">Slow Orbit</span><span className="music-track-subtitle">Nexus ambient generator</span><div className={'music-wave ' + (playing ? 'playing' : '')}>{Array.from({ length: 23 }, (_, index) => <i key={index} style={{ height: (9 + ((index * 13) % 21)) + 'px' }} />)}</div><button className="music-play" onClick={() => void toggleAmbient()}>{playing ? 'STOP AMBIENT' : 'PLAY AMBIENT'} <Music2 size={13} /></button><span className="music-note">Synthesized tone · generated locally</span></div>}
          </section>
        );
      })}

      <div className="air-os-dock">
        {(Object.keys(titles) as WindowId[]).map((id) => {
          const Icon = icons[id];
          const windowModel = windows.find((item) => item.id === id);
          const isOpen = Boolean(windowModel && !windowModel.closed && !windowModel.minimized);
          return <button key={id} className={isOpen ? 'dock-app dock-app-open' : 'dock-app'} onClick={() => openWindow(id)} aria-label={'Open ' + titles[id]} title={titles[id]}><Icon size={18} /><i /></button>;
        })}
        <span className="dock-divider" />
        <button className="dock-app" onClick={() => setShowLauncher((value) => !value)} aria-label="Open app launcher" title="App launcher"><Command size={18} /><i /></button>
        <button className="dock-app dock-settings" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle desktop theme" title="Toggle theme"><Palette size={18} /><i /></button>
        <button className="dock-app" onClick={() => { setMaximizedWindow(null); setWindows(initialWindows); }} aria-label="Reset workspace layout" title="Reset layout"><RotateCcw size={17} /><i /></button>
      </div>

      {showLauncher && <div className="air-launcher" role="dialog" aria-label="AirOS app launcher"><div className="air-launcher-heading"><div><span>WORKSPACE</span><h3>What are we opening?</h3></div><button onClick={() => setShowLauncher(false)} aria-label="Close launcher"><X size={16} /></button></div><div className="air-launcher-grid">{(Object.keys(titles) as WindowId[]).map((id) => { const Icon = icons[id]; return <button key={id} onClick={() => openWindow(id)}><span><Icon size={21} /></span><strong>{titles[id]}</strong><small>{id === 'browser' ? 'Explore your workspace' : id === 'notes' ? 'Capture an idea' : id === 'terminal' ? 'Run safe demo commands' : 'Ambient focus audio'}</small></button>; })}</div><div className="air-launcher-foot"><ShieldCheck size={13} /> Runs locally in this browser</div></div>}
      <div ref={cursorRef} className="air-hand-cursor"><span /><i /></div>
      <div className="air-os-corner">{cameraEnabled ? 'PINCH A WINDOW TITLE TO MOVE' : 'DRAG WINDOW TITLES · CAMERA OPTIONAL'} <span>·</span> PRIVATE SESSION</div>
    </div>
  );
}
