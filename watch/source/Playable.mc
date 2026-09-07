module SyncAndRun {
    class Playable extends Storable {

        function initialize(storage) {
            if ($.debug) {
            	System.println("Playable::initialize( storage = " + storage + " )");
            }

			d_storage = {
				"ids" => [],
				"types" => [],
				"idcs" => [],
				"idx" => 0,
				"shuffle" => false
			};
            Storable.initialize(storage);
        }

        function songidx() {
            return get("idx");
        }

        function ids() {
            return get("ids");
        }

        function types() {
            return get("types");
        }

        function idcs() {
            return get("idcs");
        }

        function size() {
            return ids().size();
        }

        function getSongId(idx) {
            return ids()[idcs()[idx]];
        }

        function shuffle() {
            return get("shuffle");
        }

        function getSongIds() {
            return ids();
        }

        function getAudio(idx) {
            // return null if out of bounds
            if ((idx >= idcs().size())
            	|| (idx >= ids().size())
            	|| (idx >= types().size())) {
                return null;
            }
            idx = idcs()[idx];      // rewrite to apply shuffle
            var id = ids()[idx];
            var type = types()[idx];
            return new Audio(id, type);
        }
    }

    class IPlayable extends Playable {

        function initialize() {
            if ($.debug) {
            	System.println("IPlayable::initialize()");
            }

            var storage = PlayableStore.get();
            if (storage == null) {
                storage = {};
            }
            Playable.initialize(storage);
            if (idcs().size() != ids().size()) {
                setIdx(0);
                setIdcs(new[ids().size()]);
                for (var idx = 0; idx < idcs().size(); ++idx) { idcs()[idx] = idx; }
                setShuffle(false);
                save();
            } else if ((songidx() < 0) || ((ids().size() > 0) && (songidx() >= ids().size()))) {
                setIdx(0);
                save();
            }
        }

        function save() {
            return PlayableStore.save(self);
        }

        function incSongIdx() {
            setIdx(songidx() + 1);
            return save();
        }

        function decSongIdx() {
            setIdx(songidx() - 1);
            return save();
        }

        function setAudio(audio) {
            for (var idx = 0; idx != ids().size(); ++idx) {
                var id = ids()[idx];
                var type = types()[idx];
                if ((id == audio["id"])
                    && (type == audio["type"])) {
                    setIdx(idx);
                    return save();
                }
            }
            // not found
            return false;
        }

        function setSongId(songid) {
            // find id
            for (var idx = 0; idx != ids().size(); ++idx) {
                var id = ids()[idx];
                if (id == songid) {
                    setIdx(idx);
                    return save();
                }
            }
            // not found
            return false;
        }

        function setIdx(value) {
            return set("idx", value);
        }

        function setIds(value) {
            return set("ids", value);
        }

        function setIdcs(value) {
            return set("idcs", value);
        }

        function setTypes(value) {
            return set("types", value);
        }

        function setShuffle(value) {
            return set("shuffle", value);
        }

        function removeAudioByIdx(idx) {
            if ($.debug) {
            	System.println("IPlayable::removeAudioByIdx(idx: " + idx + " )");
            	System.println(ids());
            	System.println(types());
            	System.println(idcs());
            }

            ids().remove(ids()[idx]);   // remove the id from ids
            types().remove(types()[idx]);   // remove the type from types
            idcs().remove(idx);       // remove the idx from idcs

            if ($.debug) {
            	System.println(ids().toString());
            	System.println(types().toString());
            	System.println(idcs());
            	System.println("IPlayable::removeAudioByIdx() - done");
            }
        }

        function removeRemoved() {

            if (ids().size() == 0) {
                setIdx(0);
                setIdcs([]);
                return true;
            }

            // check for ids that are no longer available
            var index = 0;
            var realidx = idcs()[songidx()];
            var changed = false;
            do {
                var id = ids()[index];
                var type = types()[index];
                var audio = new Audio(id, type);

                if (audio.refId() != null) {
                    index += 1;
                    continue;
                }
                changed = true;
                
                // this idx is removed, so no increment of idx
                ids().remove(ids()[index]);
                types().remove(types()[index]);
                
                // reset or decrease songidx if needed
                if (index == realidx) {
                    setIdx(0);
                } else if (realidx > index) {
                    realidx -= 1;
                }
            } while (index != ids().size());

			// nothing changed? nothing to do
			if (!changed) { return true; }
			
            // now reset idcs
            setIdcs(new[ids().size()]);
            for (var idx = 0; idx != idcs().size(); ++idx) {
                idcs()[idx] = idx;
            }
            // realidx == songidx when !shuffle
            setIdx(realidx);

            // if not shuffle, nothing to do
            var saved = save();
            if ($.debug) {
            	System.println("IPlayable::removeRemoved now " + d_storage);
            }
            
            if (!shuffle()) {
            	return saved;
            }
            // now fix shuffle if needed
            set("shuffle", false);
            return shuffleIdcs(true);
        }

        function shuffleIdcs(shuffle) {
            // nothing to do if same or no songs on list
            if (shuffle() == shuffle) {
                return false;
            }

            setShuffle(shuffle);
            
            // empty list cannot be shuffled
            if (size() == 0) {
                return false;
            }

            if ($.debug) {
            	System.println("Playable::shuffleIdcs() Before: " + idcs());
            	System.println("Playable::shuffleIdcs() songids: " + ids().toString());
            	System.println("Playable::shuffleIdcs() songids: " + types().toString());
            	System.println("Playable::shuffleIdcs() songidx: " + songidx());
            }

            // if not shuffle, generate 0:n array for idcs
            if (!shuffle) {
                // store the current real index
                setIdx(idcs()[songidx()]);

                setIdcs(new[ids().size()]);
                for (var idx = 0; idx != idcs().size(); ++idx) {
                    idcs()[idx] = idx;
                }
                if ($.debug) {
                	System.println("Playable::shuffleIdcs() After unshuffle:" + idcs());
                }
                return save();
            }

            // shuffle idcs around current
            var current = idcs()[songidx()];

            // shuffle the idcs
            var tmp = idcs()[0];
            idcs()[0] = idcs()[songidx()];
            idcs()[songidx()] = tmp;

            for (var idx = 1; idx != idcs().size(); ++idx) {
                tmp = idcs()[idx];
                var other = (Math.rand() % (idcs().size() - idx)) + idx;
                idcs()[idx] = idcs()[other];
                idcs()[other] = tmp;
            }
            
            if ($.debug) {
            	System.println("Playable::shuffleIdcs() After shuffle:" + idcs());
            }

            // slice last songs and prepend to account for songidx
            var splitidx = songidx();
            var end = idcs().slice(0, -splitidx);
            setIdcs(idcs().slice(-splitidx, null));
            idcs().addAll(end);
            
            if ($.debug) {
            	System.println("Playable::shuffleIdcs() After shuffle:" + idcs());
            }

            return save();
        }

        function loadIds(ids, audioid, type) {
            if ($.debug) {
            	System.println("IPlayable::loadIds( ids: " + ids + " audioid: " + audioid + " type: " + type);
            }
             
            var audioidx = 0;

            // reset ids, idcs and idx
            setIdx(0);
            setIdcs([]);

            setIds(ids);
            setTypes([]);

            setShuffle(false);

            // Active playlist membership is committed only after every audio
            // item has a durable content reference. Avoid rereading every
            // track record here; the iterator loads the selected item lazily.
            for (var idx = 0; idx != ids.size(); ++idx) {
                // check for audioid match
                if ((ids[idx] == audioid)
                    || ((audioid instanceof Lang.String)
                        && (audioid.equals(ids[idx])))) {
                    // set index to this audio if matched
                    setIdx(audioidx);
                }
                types().add(type);
                idcs().add(audioidx);

                audioidx++;
            }
            return save();
        }

        function loadPlaylist(id, songid) {
            if ($.debug) {
            	System.println("IPlayable::loadPlaylist( id: " + id + " songid: " + songid + ")");
            }
            
            // return empty array if no id available
            if (id == null) {
                return false;
            }

            var prefix = SyncAndRun.SyncStore.activePlaylistTracks(id);
            return loadIds(SyncAndRun.BoundedList.toArray(prefix), songid, Audio.SONG);
        }
        
        function loadSongIds(ids) {

            return loadIds(ids, null, Audio.SONG);
        }
    }
}
