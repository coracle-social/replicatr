# Replicatr

A daemon that monitors nostr relay selections and replicates user events based on the outbox model.

You probably don't need to run an instance of this, although a more sophisticated architecture may be needed as nostr grows (currently replicatr holds everything in memory).
