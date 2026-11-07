type TClip = {
  id: string;
  /** who triggered the clip */
  userId: number;
  channelId: number;
  /** how many seconds of media the clip holds */
  seconds: number;
  createdAt: number;
  /** plugin http route the clip file is served from */
  url: string;
};

/**
 * Declares the contract between this plugin and Sharkord: actions the client
 * can call, and what the server pushes back.
 */
type TPlugin = {
  actions: {
    clip: {
      payload: { channelId: number };
      response: TClip;
    };
  };
  push: TClip;
};

export type { TClip, TPlugin };
