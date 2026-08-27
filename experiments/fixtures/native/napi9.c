#define NAPI_VERSION 9
#include <node_api.h>
static napi_value Hi(napi_env e, napi_callback_info i){napi_value v;napi_create_string_utf8(e,"hi-from-napi9",NAPI_AUTO_LENGTH,&v);return v;}
NAPI_MODULE_INIT(){napi_value f;napi_create_function(env,"hi",NAPI_AUTO_LENGTH,Hi,NULL,&f);napi_set_named_property(env,exports,"hi",f);return exports;}
