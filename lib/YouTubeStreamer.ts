// lib/YouTubeStreamer.ts
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';

interface StreamConfig {
  audioUrl: string;
  streamKey: string;
  videoSize?: string;
  thumbnailPath?: string;
}

interface StreamProgress {
  frames?: number;
  currentFps?: number;
  currentKbps?: number;
  timemark?: string;
}

export class YouTubeStreamer extends EventEmitter {
  private process: ChildProcess | null = null;
  private _isStreaming: boolean = false;
  private config: StreamConfig;

  constructor(config: StreamConfig) {
    super();
    this.config = config;
    this._isStreaming = false;
  }

  private buildFFmpegArgs(): string[] {
    const videoSize = this.config.videoSize || '1280x720';
    const args: string[] = [];

    // Input options for audio stream
    args.push('-i', this.config.audioUrl);
    args.push('-re'); // Read input at native frame rate

    if (this.config.thumbnailPath && fs.existsSync(this.config.thumbnailPath)) {
      // Add thumbnail input
      args.push('-i', this.config.thumbnailPath);
      
      // Complex filter for thumbnail overlay
      args.push(
        '-filter_complex',
        '[1:v][0:v]scale2ref[img][color];[color][img]overlay=x=(W-w)/2:y=(H-h)/2[out]',
        '-map', '[out]',
        '-map', '0:a'
      );
    } else {
      // Create black background if no thumbnail
      args.push(
        '-f', 'lavfi',
        '-i', `color=size=${videoSize}:rate=30:color=black`
      );
    }

    // Output options
    args.push(
      '-c:v', 'libx264',         // Video codec
      '-preset', 'veryfast',     // Encoding preset
      '-b:v', '1500k',          // Video bitrate
      '-maxrate', '1500k',      // Maximum bitrate
      '-bufsize', '3000k',      // Buffer size
      '-pix_fmt', 'yuv420p',    // Pixel format
      '-g', '60',               // Keyframe interval
      '-c:a', 'aac',            // Audio codec
      '-b:a', '128k',           // Audio bitrate
      '-ar', '44100',           // Audio sample rate
      '-f', 'flv'               // Output format
    );

    // YouTube RTMP URL
    args.push(`rtmp://a.rtmp.youtube.com/live2/${this.config.streamKey}`);

    return args;
  }

  public startStream() {
    if (this._isStreaming) {
      console.log('Stream is already running');
      return;
    }

    const args = this.buildFFmpegArgs();
    console.log('Starting FFmpeg with args:', args.join(' '));

    try {
      this.process = spawn('ffmpeg', args);
      this._isStreaming = true;
      this.emit('status', { isStreaming: true });

      // Handle process events
      if (this.process.stdout) {
        this.process.stdout.on('data', (data: Buffer) => {
          const message = data.toString();
          console.log('FFmpeg stdout:', message);
          this.emit('log', { type: 'info', message });
        });
      }

      if (this.process.stderr) {
        this.process.stderr.on('data', (data: Buffer) => {
          const message = data.toString();
          console.log('FFmpeg stderr:', message);
          
          // Parse progress information
          if (message.includes('frame=')) {
            const progress = this.parseProgress(message);
            this.emit('progress', progress);
          }
          
          this.emit('log', { type: 'info', message });
        });
      }

      this.process.on('error', (err: Error) => {
        const errorMessage = `FFmpeg Error: ${err.message}`;
        console.error(errorMessage);
        this.emit('error', { 
          error: 'FFmpeg process error',
          details: errorMessage
        });
        this.cleanup();
      });

      this.process.on('exit', (code: number | null, signal: string | null) => {
        const message = `FFmpeg process exited with code ${code} and signal ${signal}`;
        console.log(message);
        this.emit('log', { type: 'info', message });
        this.cleanup();
      });

    } catch (err) {
      const error = err as Error;
      console.error('Failed to start FFmpeg:', error);
      this.emit('error', { 
        error: 'Failed to start FFmpeg',
        details: error.message
      });
      this.cleanup();
    }
  }

  private parseProgress(data: string): StreamProgress {
    const progress: StreamProgress = {};
    const parts = data.split(/\s+/);
    
    parts.forEach(part => {
      if (part.startsWith('frame=')) {
        progress.frames = parseInt(part.split('=')[1]);
      } else if (part.startsWith('fps=')) {
        progress.currentFps = parseInt(part.split('=')[1]);
      } else if (part.startsWith('bitrate=')) {
        const bitrate = part.split('=')[1];
        progress.currentKbps = parseFloat(bitrate);
      }
    });

    return progress;
  }

  public stopStream() {
    if (!this._isStreaming || !this.process) {
      console.log('No stream is running');
      return;
    }

    console.log('Stopping stream...');
    this.cleanup();
  }

  private cleanup() {
    if (this.process) {
      // Send SIGTERM to FFmpeg
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this._isStreaming = false;
    this.emit('status', { isStreaming: false });
  }

  public get isStreaming(): boolean {
    return this._isStreaming;
  }
}