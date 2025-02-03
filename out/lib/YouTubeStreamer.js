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
        this.restartTimeout = null;
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
        console.log('Starting continuous buffer...');
        this._isBuffering = true;
        this.bufferCommand = ffmpeg()
            .input(this.config.audioUrl)
            .inputOptions([
            '-f', 'aac',
            '-re' // Read input at native framerate
        ])
            .outputOptions([
            '-c:a', 'copy', // Copy audio without re-encoding
            '-f', 'segment', // Use segmenter
            '-segment_time', '5', // Create new segment every 5 seconds
            '-segment_format', 'aac',
            '-segment_wrap', '12', // Keep last 60 seconds (12 * 5s segments)
            '-reset_timestamps', '1' // Reset timestamps for each segment
        ])
            .output(path.join(os.tmpdir(), `buffer-%d.aac`))
            .on('start', () => {
            console.log('Buffer recording started');
            this.emit('buffer_start');
            // Start streaming after initial buffer period
            setTimeout(() => {
                if (!this._isStreaming) {
                    this.setupStreamCommand();
                }
            }, this.bufferSeconds * 1000);
        })
            .on('stderr', (stderrLine) => {
            console.log('Buffer:', stderrLine);
        })
            .on('error', (err) => {
            console.error('Buffer error:', err.message);
            this.emit('error', { error: err.message });
            // Attempt to restart buffer if error occurs
            this._isBuffering = false;
            if (!this.restartTimeout) {
                this.restartTimeout = setTimeout(() => {
                    this.restartTimeout = null;
                    this.startBuffering();
                }, 5000);
            }
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
        // Use the segmented buffer files
        const pattern = path.join(os.tmpdir(), 'buffer-%d.aac');
        this.command
            .input(pattern)
            .inputOptions([
            '-f', 'segment',
            '-segment_time', '5',
            '-segment_format', 'aac'
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
            // Attempt to restart stream if error occurs
            this._isStreaming = false;
            if (!this.restartTimeout) {
                this.restartTimeout = setTimeout(() => {
                    this.restartTimeout = null;
                    this.setupStreamCommand();
                }, 5000);
            }
        })
            .on('end', () => {
            console.log('FFmpeg process ended');
            // Attempt to restart if not explicitly stopped
            if (this._isStreaming && !this.restartTimeout) {
                this.restartTimeout = setTimeout(() => {
                    this.restartTimeout = null;
                    this.setupStreamCommand();
                }, 5000);
            }
        });
        // Start streaming
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
        if (this.restartTimeout) {
            clearTimeout(this.restartTimeout);
            this.restartTimeout = null;
        }
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
            // Clean up all segment files
            for (let i = 0; i < 12; i++) {
                const segmentPath = path.join(os.tmpdir(), `buffer-${i}.aac`);
                if (fs.existsSync(segmentPath)) {
                    fs.unlinkSync(segmentPath);
                }
            }
        }
        catch (err) {
            console.error('Error cleaning up buffer files:', err);
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
