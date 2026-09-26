// What the sensors measure, sampled at 4 Hz. Values are realistic for the
// place and the goods; only the speed at which a failed unit warms up is
// accelerated so an incident plays out in seconds instead of an hour.

const gauss = () => {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

export interface Sample {
  temp: number; // °C
  pressure: number; // bar (tank only)
  shock: number; // g, peak within the sample
  speed: number; // km/h (locomotive only)
}

/** Vibration felt by a wagon: rail joints and curves when moving, near nothing at rest. */
class Vibration {
  private impulses: { at: number; peak: number }[] = [];

  hit(at: number, peak: number) {
    this.impulses.push({ at, peak });
  }

  sample(now: number, speedKmh: number, storm: number): number {
    const moving = Math.min(1, speedKmh / 60);
    let g = 0.012 + Math.abs(gauss()) * (0.008 + 0.06 * moving);
    if (moving > 0 && Math.random() < 0.02 * moving) g += 0.12 + Math.random() * 0.18; // rail joint, switch
    if (storm > 0) g += Math.abs(gauss()) * 0.25 * storm + (Math.random() < 0.05 * storm ? 0.4 + Math.random() * 0.5 : 0);
    // The accelerometer samples at kHz and reports the peak of each 250 ms
    // sample, so an impact inside the sample is caught at full height.
    for (const i of this.impulses) {
      const dt = (now - i.at) / 1000;
      if (dt < 0 || dt >= 1.5) continue;
      g = Math.max(g, i.peak * (dt < 0.25 ? 1 : Math.exp(-(dt - 0.25) * 4)) * (0.97 + Math.random() * 0.06));
    }
    this.impulses = this.impulses.filter(i => now - i.at < 2000);
    return g;
  }
}

export type ReeferMode = 'running' | 'failed' | 'breached' | 'backup';

// Relaxation rates per second towards the target temperature.
const REEFER_K: Record<ReeferMode, number> = {
  running: 0.08, // unit holds the setpoint
  backup: 0.045, // backup cooling pulls the air back down
  failed: 0.013, // compressor dead, insulated body intact: slow drift towards ambient
  breached: 0.05, // unit torn off, open duct: fast exchange with outside air
};

export class ReeferModel {
  mode: ReeferMode = 'running';
  temp: number;
  private phase = Math.random() * 60;
  readonly vibration = new Vibration();

  constructor(
    public setpoint: number,
    public ambient: number,
  ) {
    this.temp = setpoint + gauss() * 0.3;
  }

  step(now: number, dt: number, speedKmh: number, storm: number): Sample {
    const cooling = this.mode === 'running' || this.mode === 'backup';
    // Compressor cycling gives the air a slow saw-tooth of about ±0.4 °C
    const target = cooling ? this.setpoint + 0.4 * Math.sin((now / 1000 + this.phase) / 6) : this.ambient;
    this.temp += (target - this.temp) * REEFER_K[this.mode] * dt + gauss() * 0.02 * Math.sqrt(dt);
    return {
      temp: this.temp + gauss() * 0.04,
      pressure: 0,
      shock: this.vibration.sample(now, speedKmh, storm),
      speed: 0,
    };
  }
}

export class TankModel {
  leaking = false;
  pressure: number;
  temp: number;
  readonly vibration = new Vibration();

  constructor(
    public nominalBar: number,
    public ambient: number,
  ) {
    this.pressure = nominalBar;
    this.temp = ambient + 0.8;
  }

  step(now: number, dt: number, speedKmh: number, storm: number): Sample {
    this.temp += (this.ambient + 0.8 - this.temp) * 0.01 * dt + gauss() * 0.01;
    if (this.leaking) {
      this.pressure += (1.0 - this.pressure) * 0.011 * dt; // towards atmospheric
    } else {
      this.pressure += (this.nominalBar - this.pressure) * 0.05 * dt;
    }
    return {
      temp: this.temp,
      pressure: this.pressure + gauss() * 0.004,
      shock: this.vibration.sample(now, speedKmh, storm),
      speed: 0,
    };
  }
}

export class LocoModel {
  speed: number;
  target: number;
  decel = 0.6; // km/h per second in service braking
  readonly vibration = new Vibration();

  constructor(speedKmh: number) {
    this.speed = speedKmh;
    this.target = speedKmh;
  }

  emergencyStop() {
    this.target = 0;
    this.decel = 6;
  }

  step(now: number, dt: number, _speed: number, storm: number): Sample {
    const diff = this.target - this.speed;
    const rate = diff < 0 ? this.decel : 0.8;
    this.speed += Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
    const cruising = this.speed > 1 ? this.speed + gauss() * 0.3 : 0;
    return {
      temp: 0,
      pressure: 0,
      shock: this.vibration.sample(now, this.speed, storm),
      speed: Math.max(0, cruising),
    };
  }
}
