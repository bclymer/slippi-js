import _ from 'lodash';
import semver from 'semver';

import {
  PostFrameUpdateType,
  GameStartType,
  GameEndType,
  Command,
  PreFrameUpdateType,
  ItemUpdateType,
  FrameBookendType,
} from '../types';
import { FramesType, FrameEntryType, Frames } from '../stats';
import { EventEmitter } from 'events';

export enum SlpParserEvent {
  SETTINGS = 'SETTINGS',
  FRAME = 'FRAME', // Emitted for every frame
  FINALIZED_FRAME = 'FINALIZED_FRAME', // Emitted for only finalized frames
}

export class SlpParser extends EventEmitter {
  private frames: FramesType = {};
  private settings: GameStartType | null = null;
  private gameEnd: GameEndType | null = null;
  private latestFrameIndex: number | null = null;
  private settingsComplete = false;
  private shouldFinalizeFrames: boolean | null = null;
  private lastFinalizedFrame = Frames.FIRST - 1;

  public getLatestFrameNumber(): number {
    return this.latestFrameIndex;
  }

  public getPlayableFrameCount(): number {
    return this.latestFrameIndex < Frames.FIRST_PLAYABLE ? 0 : this.latestFrameIndex - Frames.FIRST_PLAYABLE;
  }

  public getLatestFrame(): FrameEntryType | null {
    // return this.playerFrames[this.latestFrameIndex];

    // TODO: Modify this to check if we actually have all the latest frame data and return that
    // TODO: If we do. For now I'm just going to take a shortcut
    const allFrames = this.getFrames();
    const frameIndex = this.latestFrameIndex || Frames.FIRST;
    const indexToUse = this.gameEnd ? frameIndex : frameIndex - 1;
    return _.get(allFrames, indexToUse) || null;
  }

  public getSettings(): GameStartType | null {
    return this.settingsComplete ? this.settings : null;
  }

  public getGameEnd(): GameEndType | null {
    return this.gameEnd;
  }

  public getFrames(): FramesType | null {
    return this.frames;
  }

  public getFrame(num: number): FrameEntryType | null {
    return this.frames[num] || null;
  }

  public handleGameEnd(payload: GameEndType): void {
    payload = payload as GameEndType;
    this.gameEnd = payload;
  }

  public handleGameStart(payload: GameStartType): void {
    this.settings = payload;
    const players = payload.players;
    this.settings.players = players.filter((player) => player.type !== 3);

    // Check to see if the file was created after the sheik fix so we know
    // we don't have to process the first frame of the game for the full settings
    if (semver.gte(payload.slpVersion, '1.6.0')) {
      this._completeSettings();
    }
  }

  private _completeSettings() {
    if (!this.settingsComplete) {
      this.settingsComplete = true;
      this.emit(SlpParserEvent.SETTINGS, this.settings);
    }
  }

  public handlePostFrameUpdate(payload: PostFrameUpdateType): void {
    if (this.settingsComplete) {
      return;
    }

    // Finish calculating settings
    if (payload.frame <= Frames.FIRST) {
      const playerIndex = payload.playerIndex;
      const playersByIndex = _.keyBy(this.settings.players, 'playerIndex');

      switch (payload.internalCharacterId) {
        case 0x7:
          playersByIndex[playerIndex].characterId = 0x13; // Sheik
          break;
        case 0x13:
          playersByIndex[playerIndex].characterId = 0x12; // Zelda
          break;
      }
    }
    if (payload.frame > Frames.FIRST) {
      this._completeSettings();
    }
  }

  private _sendFrame(frame: FrameEntryType) {
    this.emit(SlpParserEvent.FRAME, frame);
    if (!this.shouldFinalizeFrames) {
      // If we're not waiting to finalize frames then fire off the final one too
      this.emit(SlpParserEvent.FINALIZED_FRAME, frame);
    }
  }

  private _setFinalizationMode(option: boolean) {
    // Only ever set this once
    if (this.shouldFinalizeFrames === null) {
      this.shouldFinalizeFrames = option;
    }
  }

  public handleFrameUpdate(command: Command, payload: PreFrameUpdateType | PostFrameUpdateType): void {
    payload = payload as PostFrameUpdateType;
    const location = command === Command.PRE_FRAME_UPDATE ? 'pre' : 'post';
    const field = payload.isFollower ? 'followers' : 'players';
    this.latestFrameIndex = payload.frame;
    _.set(this.frames, [payload.frame, field, payload.playerIndex, location], payload);
    _.set(this.frames, [payload.frame, 'frame'], payload.frame);

    // If file is from before frame bookending, add frame to stats computer here. Does a little
    // more processing than necessary, but it works
    const settings = this.getSettings();
    if (!settings || semver.lte(settings.slpVersion, '2.2.0')) {
      // We won't need to finalize frames
      this._setFinalizationMode(false);
      this._sendFrame(this.frames[payload.frame]);
    } else {
      _.set(this.frames, [payload.frame, 'isTransferComplete'], false);
    }
  }

  public handleItemUpdate(command: Command, payload: ItemUpdateType): void {
    const items = _.get(this.frames, [payload.frame, 'items'], []);
    items.push(payload);

    // Set items with newest
    _.set(this.frames, [payload.frame, 'items'], items);
  }

  public handleFrameBookend(command: Command, payload: FrameBookendType): void {
    const { frame, latestFinalizedFrame } = payload;
    // Frame 0 is falsey so check against null and undefined
    const validLatestFrame = latestFinalizedFrame !== null && latestFinalizedFrame !== undefined;
    this._setFinalizationMode(validLatestFrame && latestFinalizedFrame >= Frames.FIRST);
    _.set(this.frames, [frame, 'isTransferComplete'], true);
    // Fire off a normal frame event
    this._sendFrame(this.frames[frame]);
    // Finalize frames if necessary
    this._finalizeFrames(latestFinalizedFrame);
  }

  /**
   * Fires off the FINALIZED_FRAME event for frames up until a certain number
   * @param num The frame to finalize until
   */
  private _finalizeFrames(num: number) {
    // Only fire events if we're in finalization mode
    if (this.shouldFinalizeFrames) {
      while (this.lastFinalizedFrame < num) {
        this.lastFinalizedFrame++;
        this.emit(SlpParserEvent.FINALIZED_FRAME, this.getFrame(this.lastFinalizedFrame));
      }
    }
  }
}
