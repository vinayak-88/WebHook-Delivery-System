const mongoose = require("mongoose");

/*
Secret is intentionally excluded — it is never snapshotted into the event document or Redis job data.
The worker fetches it fresh from the Subscriber collection at delivery time to minimise plaintext exposure.
*/

const deliveryTargetSchema = new mongoose.Schema(
  {
    subscriberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscriber",
      required: true,
    },
    subscriberUrl: {
      type: String,
      required: true,
    },
  },
  { _id: false },
);

const eventSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      trim: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    deliveryTargets: {
      type: [deliveryTargetSchema],
      default: [],
      validate:{
        validator : function (arr){
          const ids = arr.map(t => t.subscriberId.toString());
            return new Set(ids).size === ids.length;
          }, 
          message : "deliveryTargets contains duplicate subscriberIds"
      }
    },
    queueStatus: {
      type: String,
      enum: ["pending", "queued", "no_subscribers"],
      default: "pending",
    },
    queuedJobCount: {
      type: Number,
      default: 0,
    },

    //It tells you exactly when this event was handed off to the queue
    //Useful for debugging scenarios like "why did delivery take so long?
    queueEnqueuedAt: {
      type: Date,
      default: null,
    },
    queueErrors: [
      {
        message: String,
        subscriberId: mongoose.Schema.Types.ObjectId,
        occurredAt: Date,
      },
    ],
  },
  { timestamps: true },
);

module.exports = mongoose.model("Event", eventSchema);
