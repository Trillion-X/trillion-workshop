// Canonical public-listing meaning. The two serialization groups retain the
// existing publication order around its owned timestamp; neither supplies a
// publication, handle claim, current-source proof or private profile fields.
import rules from '../../introduce-two-people/src/network-settings.json' with {type:'json'};

export function networkPublicationShape({handle='',links=[]}={}){
  const normalizedHandle = String(handle).trim().replace(/^@/, '').toLowerCase();
  if (normalizedHandle && !/^[a-z0-9_]{3,32}$/.test(normalizedHandle)) throw new Error('Your handle needs 3 to 32 letters, numbers or underscores.');
  if (!Array.isArray(links) || links.length > 8 || links.some(link => typeof link !== 'string' || !/^https:\/\//.test(link) || link.length > 500)) throw new Error('Links must be HTTPS addresses, at most eight.');
  return {
    handle:normalizedHandle,
    fields({offering,seeking,embedding,name='',about='',open_to_messages=false,pursuits=[],share_service_names=false,service_providers=[]}){
      const shown = (Array.isArray(pursuits) ? pursuits : []).filter(item => typeof item?.title === 'string' && Array.isArray(item.embedding)).slice(0, rules.on_your_path.pursuits_shown)
        .map(item => ({ title: item.title.trim().slice(0, 160), embedding: item.embedding }));
      const sharesServices = share_service_names === true && shown.length > 0;
      const providers = sharesServices && Array.isArray(service_providers)
        ? [...new Set(service_providers.filter(id => typeof id === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(id)))].slice(0, 200)
        : [];
      return {
        beforeTimestamp:()=>[String(offering ?? '').trim().slice(0, 600),String(seeking ?? '').trim().slice(0, 600),JSON.stringify(embedding)],
        afterTimestamp:()=>[String(name).trim().slice(0, 100),normalizedHandle || null,String(about).trim().slice(0, 1000),JSON.stringify(links),open_to_messages ? 1 : 0,JSON.stringify(shown),sharesServices ? 1 : 0,JSON.stringify(providers)],
      };
    },
  };
}
