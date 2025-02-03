// lib/YouTubeStreamer.ts
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import { EventEmitter } from 'events';
import path from 'path';
import os from 'os';
export class YouTubeStreamer extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this._isStreaming = false;
        this._isBuffering = false;
        this.bufferCommand = null;
        this.bufferSeconds = config.bufferSeconds || 30;
        this.bufferPath = path.join(os.tmpdir(), `yt-buffer-${Date.now()}.aac`);
        // In Docker, use system ffmpeg instead of ffmpeg-static
        const ffmpegBinary = process.env.DOCKER_CONTAINER ? 'ffmpeg' : ffmpegPath;
        console.log('Using FFmpeg binary:', ffmpegBinary);
        // Set default video size if not provided
        const videoSize = this.config.videoSize || '1280x720';
        this.command = null;
        // Start buffering immediately
        this.startBuffering();
    }
    async startBuffering() {
        if (this._isBuffering)
            return;
        console.log('Starting buffer...');
        this._isBuffering = true;
        this.bufferCommand = ffmpeg()
            .input(this.config.audioUrl)
            .inputOptions(['-f', 'aac'])
            .outputOptions([
            '-t', this.bufferSeconds.toString(), // Duration to capture
            '-c:a', 'copy' // Copy audio without re-encoding
        ])
            .output(this.bufferPath)
            .on('start', () => {
            console.log('Buffer recording started');
            this.emit('buffer_start');
        })
            .on('progress', (progress) => {
            const percent = (parseFloat(progress.timemark) / this.bufferSeconds) * 100;
            this.emit('buffer_progress', { percent, timemark: progress.timemark });
        })
            .on('end', () => {
            console.log('Buffer recording complete');
            this._isBuffering = false;
            this.emit('buffer_ready');
            this.setupStreamCommand();
        })
            .on('error', (err) => {
            console.error('Buffer error:', err.message);
            this._isBuffering = false;
            this.emit('error', { error: err.message });
        });
        this.bufferCommand.run();
    }
    setupStreamCommand() {
        // Convert Windows-style paths to POSIX paths in Docker environment
        let thumbnailPath = this.config.thumbnailPath;
        if (thumbnailPath && process.env.DOCKER_CONTAINER) {
            thumbnailPath = thumbnailPath.replace(/\\/g, '/');
            if (thumbnailPath.includes(':')) {
                thumbnailPath = thumbnailPath.split(':')[1];
            }
        }
        this.command = ffmpeg();
        // If thumbnail is provided, use it; otherwise use black background
        if (thumbnailPath && fs.existsSync(thumbnailPath)) {
            console.log('Using thumbnail:', thumbnailPath);
            this.command
                .input(thumbnailPath)
                .inputOptions([
                '-loop 1',
                '-framerate 1'
            ]);
        }
        else {
            console.log('Using black background');
            this.command
                .input('nullsrc')
                .inputOptions([
                '-f', 'rawvideo',
                '-video_size', this.config.videoSize || '1280x720',
                '-pix_fmt', 'rgb24',
                '-r', '1'
            ])
                .videoFilters([
                'geq=r=0:g=0:b=0'
            ]);
        }
        // Create a concat file for seamless playback
        const concatFile = path.join(os.tmpdir(), `concat-${Date.now()}.txt`);
        fs.writeFileSync(concatFile, `file '${this.bufferPath}'\nfile '${this.config.audioUrl}'`);
        // Add concatenated audio input
        this.command
            .input(concatFile)
            .inputOptions([
            '-f', 'concat',
            '-safe', '0'
        ])
            // Video settings
            .videoCodec('libx264')
            .outputOptions([
            '-preset ultrafast',
            '-tune stillimage',
            '-r 1',
            '-g 2',
            '-c:a copy',
            '-shortest',
            '-pix_fmt yuv420p',
            '-f flv'
        ])
            .output(`rtmp://a.rtmp.youtube.com/live2/${this.config.streamKey}`)
            .on('start', (commandLine) => {
            console.log('FFmpeg stream started with command:', commandLine);
            this._isStreaming = true;
            this.emit('status', { isStreaming: true, command: commandLine });
        })
            .on('stderr', (stderrLine) => {
            console.log('FFmpeg:', stderrLine);
            this.emit('log', { type: 'ffmpeg', message: stderrLine });
        })
            .on('progress', (progress) => {
            const streamProgress = {
                frames: progress.frames,
                currentFps: progress.currentFps,
                currentKbps: progress.currentKbps,
                timemark: progress.timemark
            };
            this.emit('progress', streamProgress);
        })
            .on('error', (err, stdout, stderr) => {
            console.error('Stream error:', err.message);
            this.emit('error', { error: err.message, stdout, stderr });
            this.cleanup();
        })
            .on('end', () => {
            console.log('FFmpeg process ended');
            this.cleanup();
            this.emit('end');
        });
        // Start streaming automatically after setup
        this.startStream();
    }
    startStream() {
        if (this._isStreaming || !this.command) {
            return;
        }
        console.log('Starting stream with buffered content...');
        this._isStreaming = true;
        this.command.run();
    }
    stopStream() {
        if (this._isStreaming && this.command) {
            this._isStreaming = false;
            this.command.kill('SIGKILL');
            this.command = null;
            this.emit('status', { isStreaming: false });
        }
        if (this._isBuffering && this.bufferCommand) {
            this._isBuffering = false;
            this.bufferCommand.kill('SIGKILL');
            this.bufferCommand = null;
        }
        this.cleanup();
    }
    cleanup() {
        this._isStreaming = false;
        this._isBuffering = false;
        // Clean up temporary files
        try {
            if (fs.existsSync(this.bufferPath)) {
                fs.unlinkSync(this.bufferPath);
            }
        }
        catch (err) {
            console.error('Error cleaning up buffer file:', err);
        }
        this.emit('status', { isStreaming: false });
    }
    get isStreaming() {
        return this._isStreaming;
    }
    get isBuffering() {
        return this._isBuffering;
    }
    getStatus() {
        return {
            isStreaming: this._isStreaming,
            isBuffering: this._isBuffering,
            config: this.config
        };
    }
}
