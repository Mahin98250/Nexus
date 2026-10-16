import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, Pause, RotateCcw, Swords, Zap } from 'lucide-react';
import type { BodyInputRef } from '../vision/types';

type Phase = 'playing' | 'paused' | 'over';
type Enemy = { id: number; x: number; y: number; speed: number; size: number; spin: number };
type GameState = {
  score: number;
  lives: number;
  playerX: number;
  enemies: Enemy[];
  lastSpawn: number;
  nextId: number;
  punchUntil: number;
  jumpUntil: number;
  lastAttack: boolean;
  lastJump: boolean;
  lastTime: number;
  phase: Phase;
};

type Props = { bodyInputRef: BodyInputRef; cameraEnabled: boolean };

const newGame = (): GameState => ({
  score: 0, lives: 3, playerX: 0.5, enemies: [], lastSpawn: 0, nextId: 1,
  punchUntil: 0, jumpUntil: 0, lastAttack: false, lastJump: false, lastTime: 0,
  phase: 'playing',
});

export default function ShadowStrikeGame({ bodyInputRef, cameraEnabled }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<GameState>(newGame());
  const cameraRef = useRef(cameraEnabled);
  const resetRef = useRef<() => void>(() => undefined);
  const phaseRef = useRef<Phase>('playing');
  const controlsRef = useRef({ left: false, right: false, attack: false });
  const [hud, setHud] = useState({ score: 0, lives: 3, bodyDetected: false });
  const [phase, setPhase] = useState<Phase>('playing');
  cameraRef.current = cameraEnabled;

  const changePhase = (next: Phase) => {
    phaseRef.current = next;
    gameRef.current.phase = next;
    setPhase(next);
  };

  const resetGame = () => {
    gameRef.current = newGame();
    phaseRef.current = 'playing';
    setPhase('playing');
    setHud({ score: 0, lives: 3, bodyDetected: bodyInputRef.current.detected });
  };
  resetRef.current = resetGame;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    let disposed = false;
    let frame = 0;
    let lastHudUpdate = 0;
    let width = 1;
    let height = 1;
    let pixelRatio = 1;
    const stars = Array.from({ length: 65 }, () => ({
      x: Math.random(), y: Math.random(), size: 0.5 + Math.random() * 1.3,
      alpha: 0.18 + Math.random() * 0.48,
    }));

    const resize = () => {
      width = Math.max(canvas.clientWidth, 1);
      height = Math.max(canvas.clientHeight, 1);
      pixelRatio = Math.min(window.devicePixelRatio || 1, 1.7);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const keyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (['arrowleft', 'arrowright', 'arrowup', ' ', 'a', 'd', 'w'].includes(key)) event.preventDefault();
      if (key === 'arrowleft' || key === 'a') controlsRef.current.left = true;
      if (key === 'arrowright' || key === 'd') controlsRef.current.right = true;
      if (key === ' ' || key === 'arrowup' || key === 'w') controlsRef.current.attack = true;
      if (key === 'enter' && phaseRef.current === 'over') resetRef.current();
    };
    const keyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === 'arrowleft' || key === 'a') controlsRef.current.left = false;
      if (key === 'arrowright' || key === 'd') controlsRef.current.right = false;
      if (key === ' ' || key === 'arrowup' || key === 'w') controlsRef.current.attack = false;
    };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);

    const draw = (now: number) => {
      if (disposed) return;
      frame = requestAnimationFrame(draw);
      const game = gameRef.current;
      const delta = Math.min((now - (game.lastTime || now)) / 1000, 0.04);
      game.lastTime = now;
      const ctx = context;

      ctx.clearRect(0, 0, width, height);
      if (!cameraRef.current) {
        const background = ctx.createLinearGradient(0, 0, width, height);
        background.addColorStop(0, '#0c1020');
        background.addColorStop(0.55, '#0a0d18');
        background.addColorStop(1, '#121025');
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
      } else {
        ctx.fillStyle = 'rgba(6, 9, 18, 0.22)';
        ctx.fillRect(0, 0, width, height);
      }

      stars.forEach((star) => {
        ctx.fillStyle = 'rgba(190, 202, 255, ' + star.alpha + ')';
        ctx.fillRect(star.x * width, star.y * height, star.size, star.size);
      });
      ctx.strokeStyle = 'rgba(139, 122, 255, 0.10)';
      ctx.lineWidth = 1;
      for (let lane = 0; lane <= 8; lane += 1) {
        const x = (lane / 8) * width;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(width / 2 + (x - width / 2) * 1.22, height);
        ctx.stroke();
      }
      for (let row = 0; row < 8; row += 1) {
        const y = (row / 7) * height;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      const body = cameraRef.current ? bodyInputRef.current : undefined;
      const hasBody = Boolean(body?.detected);
      const keys = controlsRef.current;
      const attack = Boolean((hasBody && body?.attack) || keys.attack);
      const jump = Boolean(hasBody && body?.jump);

      // Freeze player input while paused or after game over, but keep edge-state
      // synchronized so holding a gesture does not fire unexpectedly on resume.
      if (game.phase === 'playing') {
        let desiredX = game.playerX;
        if (hasBody && body) desiredX = body.x;
        else if (keys.left !== keys.right) desiredX += keys.left ? -delta * 1.35 : delta * 1.35;
        desiredX = Math.max(0.08, Math.min(0.92, desiredX));
        game.playerX += (desiredX - game.playerX) * (1 - Math.exp(-delta * 10));
        if (attack && !game.lastAttack) game.punchUntil = now + 280;
        if (jump && !game.lastJump) game.jumpUntil = now + 520;
      }
      game.lastAttack = attack;
      game.lastJump = jump;

      if (game.phase === 'playing') {
        if (now - game.lastSpawn > Math.max(440, 950 - game.score * 1.7)) {
          game.enemies.push({
            id: game.nextId++, x: 0.08 + Math.random() * 0.84, y: -22,
            speed: 65 + Math.random() * 40 + Math.min(game.score * 0.45, 65),
            size: 10 + Math.random() * 5, spin: Math.random() * Math.PI,
          });
          game.lastSpawn = now;
        }
        const playerY = height * (game.jumpUntil > now ? 0.74 : 0.835);
        const punchActive = game.punchUntil > now;
        const remaining: Enemy[] = [];
        game.enemies.forEach((enemy) => {
          enemy.y += enemy.speed * delta;
          enemy.spin += delta * 1.7;
          const dx = enemy.x * width - game.playerX * width;
          const dy = enemy.y - playerY;
          if (punchActive && Math.hypot(dx, dy) < Math.max(88, width * 0.12)) {
            game.score += 10;
            return;
          }
          if (enemy.y > height * 0.97) {
            game.lives = Math.max(0, game.lives - 1);
            return;
          }
          remaining.push(enemy);
        });
        game.enemies = remaining;
        if (game.lives <= 0) {
          game.phase = 'over';
          phaseRef.current = 'over';
          setPhase('over');
        }
      }

      game.enemies.forEach((enemy) => {
        const x = enemy.x * width;
        const glow = ctx.createRadialGradient(x, enemy.y, 1, x, enemy.y, enemy.size * 2.8);
        glow.addColorStop(0, 'rgba(255, 153, 120, 0.26)');
        glow.addColorStop(1, 'rgba(255, 100, 130, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, enemy.y, enemy.size * 2.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.translate(x, enemy.y);
        ctx.rotate(enemy.spin);
        ctx.strokeStyle = '#ff9b94';
        ctx.lineWidth = 1.5;
        ctx.fillStyle = 'rgba(255, 99, 125, 0.15)';
        ctx.beginPath();
        ctx.moveTo(0, -enemy.size);
        ctx.lineTo(enemy.size, 0);
        ctx.lineTo(0, enemy.size);
        ctx.lineTo(-enemy.size, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      });

      const playerX = game.playerX * width;
      const playerY = height * (game.jumpUntil > now ? 0.74 : 0.835);
      const playerGlow = ctx.createRadialGradient(playerX, playerY, 2, playerX, playerY, 52);
      playerGlow.addColorStop(0, 'rgba(112, 226, 232, 0.24)');
      playerGlow.addColorStop(1, 'rgba(112, 226, 232, 0)');
      ctx.fillStyle = playerGlow;
      ctx.beginPath();
      ctx.arc(playerX, playerY, 52, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#a5f0e8';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(playerX, playerY - 27, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(playerX, playerY - 18);
      ctx.lineTo(playerX, playerY + 7);
      ctx.moveTo(playerX, playerY - 11);
      ctx.lineTo(playerX - 13, playerY - 1);
      ctx.moveTo(playerX, playerY - 11);
      ctx.lineTo(playerX + (game.punchUntil > now ? 25 : 13), playerY - (game.punchUntil > now ? 16 : 1));
      ctx.moveTo(playerX, playerY + 7);
      ctx.lineTo(playerX - 11, playerY + 22);
      ctx.moveTo(playerX, playerY + 7);
      ctx.lineTo(playerX + 11, playerY + 22);
      ctx.stroke();
      if (game.punchUntil > now) {
        const progress = 1 - (game.punchUntil - now) / 280;
        ctx.strokeStyle = 'rgba(132, 227, 255, ' + (1 - progress) + ')';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(playerX, playerY - 6, 22 + progress * 58, -0.9, 0.9);
        ctx.stroke();
      }

      if (now - lastHudUpdate > 180) {
        setHud({ score: game.score, lives: game.lives, bodyDetected: Boolean(body?.detected) });
        lastHudUpdate = now;
      }
    };

    frame = requestAnimationFrame(draw);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
    };
  }, [bodyInputRef]);

  return (
    <div className="shadow-game-layer">
      <canvas ref={canvasRef} className="shadow-game-canvas" aria-label="ShadowStrike arcade game. Move left and right and raise a hand or press space to punch falling targets." />
      <div className="shadow-game-top">
        <div className="game-status-chip"><span className={cameraEnabled && hud.bodyDetected ? 'status-dot active' : 'status-dot'} />{cameraEnabled ? (hud.bodyDetected ? 'BODY TRACKED' : 'FIND FULL BODY') : 'KEYBOARD MODE'}</div>
        <div className="game-score-chip"><span>SCORE</span><strong>{String(hud.score).padStart(5, '0')}</strong></div>
        <div className="game-lives-chip"><span>ENERGY</span><strong>{'◆ '.repeat(hud.lives).trim() || '—'}</strong></div>
      </div>
      {(phase === 'over' || phase === 'paused') && <div className="game-message"><div className="game-message-icon"><Swords size={21} /></div><span className="eyebrow">{phase === 'over' ? 'SIMULATION ENDED' : 'PAUSED'}</span><h3>{phase === 'over' ? 'One more run?' : 'Take a breath.'}</h3><p>{phase === 'over' ? 'You scored ' + hud.score + ' points. Ready to jump back in?' : 'The arena is waiting for you.'}</p><button className="button button-primary" onClick={phase === 'over' ? resetGame : () => changePhase('playing')}>{phase === 'over' ? <RotateCcw size={15} /> : <Zap size={15} />} {phase === 'over' ? 'Restart run' : 'Resume game'}</button></div>}
      <div className="shadow-game-bottom">
        <div className="game-controls-help">{cameraEnabled ? 'MOVE YOUR BODY TO STEER' : 'ARROWS / A-D TO MOVE'} <span>·</span> {cameraEnabled ? 'RAISE A HAND TO STRIKE' : 'SPACE TO STRIKE'}</div>
        <div className="shadow-touch-controls">
          <button aria-label="Move left" onPointerDown={() => { controlsRef.current.left = true; }} onPointerUp={() => { controlsRef.current.left = false; }} onPointerLeave={() => { controlsRef.current.left = false; }} onPointerCancel={() => { controlsRef.current.left = false; }}><ArrowLeft size={18} /></button>
          <button aria-label="Jump or strike" onPointerDown={() => { controlsRef.current.attack = true; }} onPointerUp={() => { controlsRef.current.attack = false; }} onPointerLeave={() => { controlsRef.current.attack = false; }} onPointerCancel={() => { controlsRef.current.attack = false; }}><ArrowUp size={18} /></button>
          <button aria-label="Move right" onPointerDown={() => { controlsRef.current.right = true; }} onPointerUp={() => { controlsRef.current.right = false; }} onPointerLeave={() => { controlsRef.current.right = false; }} onPointerCancel={() => { controlsRef.current.right = false; }}><ArrowRight size={18} /></button>
        </div>
        {phase !== 'over' && <button className="game-pause" onClick={() => changePhase(phase === 'paused' ? 'playing' : 'paused')} aria-label={phase === 'paused' ? 'Resume game' : 'Pause game'}><Pause size={14} /> {phase === 'paused' ? 'RESUME' : 'PAUSE'}</button>}
      </div>
    </div>
  );
}
