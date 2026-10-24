// CLI composition surface; the SQLite repository stays behind the adapter boundary.
export {
  captureChannelBodyFile,
  captureChannelBodyText,
  channelStorageError,
  createNodeChannelPorts,
  releaseAcceptedChannelBody,
  sweepChannelAcceptedInputs,
  type NodeChannelPorts,
} from "./channels";
