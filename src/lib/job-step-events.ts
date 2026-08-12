import type {
  JobStepStreamEvent,
  JobStepStreamEventType,
  StreamablePipelineStep
} from "../types.js";

type EventInput = {
  type: JobStepStreamEventType;
  delta?: string;
  text?: string;
  model?: string;
  message?: string;
};

type Channel = {
  nextId: number;
  events: JobStepStreamEvent[];
  listeners: Set<(event: JobStepStreamEvent) => void>;
};

export class JobStepEventHub {
  private readonly channels = new Map<string, Channel>();

  constructor(private readonly maxEvents = 50) {}

  publish(jobId: string, step: StreamablePipelineStep, input: EventInput): JobStepStreamEvent {
    const channel = this.channel(jobId, step);
    if (input.type === "started") {
      channel.nextId = 1;
      channel.events = [];
    }
    const event: JobStepStreamEvent = {
      id: channel.nextId++,
      jobId,
      step,
      ...input
    };
    channel.events.push(event);
    if (channel.events.length > this.maxEvents) {
      channel.events.splice(0, channel.events.length - this.maxEvents);
    }
    for (const listener of channel.listeners) {
      try {
        listener(event);
      } catch {
        channel.listeners.delete(listener);
      }
    }
    return event;
  }

  subscribe(
    jobId: string,
    step: StreamablePipelineStep,
    listener: (event: JobStepStreamEvent) => void,
    afterId = 0
  ) {
    const channel = this.channel(jobId, step);
    channel.listeners.add(listener);
    for (const event of channel.events) {
      if (event.id > afterId) {
        try {
          listener(event);
        } catch {
          channel.listeners.delete(listener);
          break;
        }
      }
    }
    return () => {
      channel.listeners.delete(listener);
    };
  }

  private channel(jobId: string, step: StreamablePipelineStep) {
    const key = `${jobId}:${step}`;
    let channel = this.channels.get(key);
    if (!channel) {
      channel = { nextId: 1, events: [], listeners: new Set() };
      this.channels.set(key, channel);
    }
    return channel;
  }
}
