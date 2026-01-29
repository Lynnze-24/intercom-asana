import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import FormData from 'form-data';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Asana configuration
const ASANA_TOKEN = process.env.ASANA_TOKEN;
const ASANA_WORKSPACE = process.env.ASANA_WORKSPACE;
const ASANA_PROJECT = process.env.ASANA_PROJECT;

if (!ASANA_TOKEN || !ASANA_WORKSPACE || !ASANA_PROJECT) {
  throw new Error(
    [
      'Missing required Asana environment variables.',
      'Set these in your environment (or copy .env.example to .env):',
      '- ASANA_TOKEN',
      '- ASANA_WORKSPACE',
      '- ASANA_PROJECT',
    ].join('\n')
  );
}

// Asana Custom Field GIDs - Will be automatically populated on server start
const ASANA_CUSTOM_FIELDS = {
  CASH_OUT_DATE_AND_TIME: null, // Date field in Intercom, Text in Asana (Singapore timezone)
  CASH_OUT_SLIP: null, // File upload field
  E_WALLET: null, // Text field
  TRANSACTION_ID: null, // Text field
  AGENT_NUMBER: null, // Text field
  AMOUNT: null, // Text field
  REMARK: null, // Text field
  CASHOUT_SLIP_ASANA: null, // File upload field (Asana specific)
  INTERCOM_CONVERSATION_ID: null, // For webhook sync back to Intercom
  TICKET_STATUS: null, // For syncing ticket status between Asana and Intercom
};

// Cache for custom field mappings and types
let customFieldsCache = null;
let customFieldTypes = {};

// Intercom configuration
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const INTERCOM_ADMIN_ID = process.env.INTERCOM_ADMIN_ID;

if (!INTERCOM_TOKEN || !INTERCOM_ADMIN_ID) {
  throw new Error(
    [
      'Missing required Intercom environment variables.',
      'Set these in your environment (or copy .env.example to .env):',
      '- INTERCOM_TOKEN',
      '- INTERCOM_ADMIN_ID',
    ].join('\n')
  );
}

// Cache for ticket states fetched from Intercom API
let ticketStatesCache = null;

// Helper function to fetch all ticket states from Intercom API
async function fetchTicketStates() {
  try {
    console.log('Fetching ticket states from Intercom API...');
    const response = await fetch('https://api.intercom.io/ticket_states', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${INTERCOM_TOKEN}`,
        'Intercom-Version': '2.14',
        Accept: 'application/json',
      },
    });

    if (response.ok) {
      const responseData = await response.json();
      const states = responseData.data || []; // API returns states in 'data' array, not 'ticket_states'
      console.log(`✓ Fetched ${states.length} ticket states from Intercom`);
      
      // Log available states for reference
      if (states.length > 0) {
        console.log('Available ticket states:');
        states.forEach((state) => {
          const ticketTypesCount = state.ticket_types?.data?.length || 0;
          console.log(
            `  - ${state.internal_label} (category: ${state.category}, id: ${state.id}, applies to ${ticketTypesCount} ticket type(s))`
          );
        });
      }
      
      return states;
    } else {
      const errorData = await response.json();
      console.error('Error fetching ticket states from Intercom:', errorData);
      return [];
    }
  } catch (error) {
    console.error('Error fetching ticket states:', error);
    return [];
  }
}

// Helper function to initialize ticket states cache
async function initializeTicketStates() {
  if (!ticketStatesCache) {
    ticketStatesCache = await fetchTicketStates();
  }
  return ticketStatesCache;
}

// Helper function to get ticket state ID by label or category
// Optionally filter by ticket type ID for more accurate matching
async function getTicketStateId(labelOrCategory, ticketTypeId = null) {
  // Ensure ticket states are loaded
  const states = await initializeTicketStates();
  
  if (!states || states.length === 0) {
    console.error('No ticket states available');
    return null;
  }

  // Filter states by ticket type if provided
  let applicableStates = states;
  if (ticketTypeId) {
    applicableStates = states.filter(state => 
      state.ticket_types?.data?.some(type => String(type.id) === String(ticketTypeId))
    );
    console.log(`  Filtered to ${applicableStates.length} states for ticket type ${ticketTypeId} (from ${states.length} total states)`);
    
    if (applicableStates.length > 0) {
      console.log('  Applicable states:', applicableStates.map(s => s.internal_label).join(', '));
    }
  }

  const normalizedInput = labelOrCategory.toLowerCase().trim();

  // Try to find by internal label
  let state = applicableStates.find(
    (s) => s.internal_label.toLowerCase() === normalizedInput
  );

  // Try to find by external label
  if (!state) {
    state = applicableStates.find(
      (s) => s.external_label.toLowerCase() === normalizedInput
    );
  }

  // Try to find by category
  if (!state) {
    state = applicableStates.find(
      (s) => s.category.toLowerCase() === normalizedInput
    );
  }

  return state ? state.id : null;
}

// Asana webhook secret (will be set during webhook handshake)
let asanaWebhookSecret = null;

// Map to store Asana task ID to Intercom conversation ID
const asanaTaskToConversation = new Map();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

/*
  This object defines the canvas that will display when your app initializes.
  It includes a button to create an Asana task for the contact.
  
  More information on these can be found in the reference docs.
  Canvas docs: https://developers.intercom.com/docs/references/canvas-kit/responseobjects/canvas/
  Components docs: https://developers.intercom.com/docs/references/canvas-kit/interactivecomponents/button/
*/
const initialCanvas = {
  canvas: {
    content: {
      components: [
        {
          type: 'text',
          id: 'header',
          text: 'Asana Integration',
          align: 'center',
          style: 'header',
        },
        {
          type: 'text',
          id: 'description',
          text: 'Create Asana Task for Ticket',
          align: 'center',
          style: 'muted',
        },
        {
          type: 'spacer',
          id: 'spacer_1',
          size: 's',
        },
        {
          type: 'button',
          label: 'Create Task',
          style: 'primary',
          id: 'submit_button',
          action: {
            type: 'submit',
          },
        },
      ],
    },
  },
};

// Helper function to get contact name from Intercom API
async function getContactName(contactId) {
  try {
    const response = await fetch(
      `https://api.intercom.io/contacts/${contactId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data.name || 'Unknown Contact';
    }
    return 'Unknown Contact';
  } catch (error) {
    console.error('Error fetching contact from Intercom:', error);
    return 'Unknown Contact';
  }
}

// Helper function to get conversation details from Intercom API
async function getConversation(conversationId) {
  try {
    const response = await fetch(
      `https://api.intercom.io/conversations/${conversationId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.11',
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data;
    }
    return null;
  } catch (error) {
    console.error('Error fetching conversation from Intercom:', error);
    return null;
  }
}

// Helper function to get ticket details from Intercom Tickets API
async function getTicket(ticketId) {
  try {
    console.log(`  → Fetching ticket ${ticketId} from Intercom...`);
    const response = await fetch(
      `https://api.intercom.io/tickets/${ticketId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.14',
          Accept: 'application/json',
        },
      }
    );

    console.log(`  → Ticket API response status: ${response.status}`);

    if (response.ok) {
      const data = await response.json();
      console.log(`  ✓ Ticket fetched successfully. Has attributes:`, !!data.ticket_attributes);
      return data;
    } else {
      const errorData = await response.json().catch(() => ({}));
      console.error(`  ✗ Ticket API error (${response.status}):`, errorData);
      return null;
    }
  } catch (error) {
    console.error('  ✗ Error fetching ticket from Intercom:', error.message);
    return null;
  }
}



// Helper function to get conversation ID from Asana task
async function getConversationIdFromTask(taskId) {
  try {
    console.log('  Fetching task details from Asana...');
    const taskResponse = await fetch(
      `https://app.asana.com/api/1.0/tasks/${taskId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          Accept: 'application/json',
        },
      }
    );

    if (!taskResponse.ok) {
      const errorText = await taskResponse.text();
      console.error(
        '  ✗ Failed to fetch task details. Status:',
        taskResponse.status
      );
      console.error('  Error response:', errorText);
      return null;
    }

    const taskData = await taskResponse.json();
    const customFields = taskData.data.custom_fields || [];

    console.log(`  Found ${customFields.length} custom fields on task`);

    // Get conversation ID from custom fields
    let conversationId = null;

    for (const field of customFields) {
      // Match by GID or by field name (fallback if GID not mapped)
      if (
        field.gid === ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID ||
        field.name === 'Intercom Conversation ID'
      ) {
        // Try multiple properties where the value might be stored
        conversationId =
          field.text_value ||
          field.display_value ||
          field.number_value ||
          (typeof field.value === 'string' ? field.value : null);

        console.log(
          '  ✓ Found Intercom Conversation ID field:',
          JSON.stringify(field, null, 2)
        );
        console.log(
          '  → Extracted conversation ID:',
          conversationId,
          `(matched by ${
            field.gid === ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID
              ? 'GID'
              : 'name'
          })`
        );
        break;
      }
    }

    // Fallback to in-memory map if custom field not found
    if (!conversationId) {
      conversationId = asanaTaskToConversation.get(taskId);
      if (conversationId) {
        console.log('  ✓ Found conversation ID in memory map:', conversationId);
      }
    }

    if (!conversationId) {
      console.log('  ✗ No conversation ID found for this task');
      console.log('  Possible causes:');
      console.log(
        '    1. ⚠ The "Intercom Conversation ID" field has no value on this task'
      );
      console.log(
        '    2. ⚠ This task was created before the field was added, OR'
      );
      console.log(
        '    3. ⚠ The task was not created through the Intercom integration'
      );
    }

    return { conversationId, taskData: taskData.data };
  } catch (error) {
    console.error('  ✗ Error fetching conversation ID from task:', error);
    return null;
  }
}

// Helper function to update Intercom ticket attributes
async function updateTicketAttribute(ticketId, asanaTaskId) {
  try {
    console.log(`Updating ticket ${ticketId} with Asana Task ID: ${asanaTaskId}`);
    const response = await fetch(
      `https://api.intercom.io/tickets/${ticketId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.14',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          ticket_attributes: {
            'Asana Task ID': asanaTaskId, // Use exact field name with spaces
          },
        }),
      }
    );

    if (response.ok) {
      const data = await response.json();
      console.log('✓ Successfully updated ticket with Asana task ID');
      console.log('Updated ticket attributes:', data.ticket_attributes?.['Asana Task ID']);
      return true;
    } else {
      const errorData = await response.json();
      console.error('✗ Error updating ticket:', errorData);
      return false;
    }
  } catch (error) {
    console.error('✗ Error updating ticket attribute:', error);
    return false;
  }
}

// Helper function to update Intercom ticket Ticket Status field
async function updateTicketStatus(ticketId, status) {
  try {
    console.log(`Updating ticket ${ticketId} Ticket Status to: "${status}"`);

    const response = await fetch(
      `https://api.intercom.io/tickets/${ticketId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.14',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          ticket_attributes: {
            'Ticket Status': status,
          },
        }),
      }
    );

    if (response.ok) {
      console.log(`✓ Successfully updated Ticket Status to "${status}"`);
      return true;
    } else {
      const errorData = await response.json();
      console.error('✗ Error updating Ticket Status:', errorData);
      return false;
    }
  } catch (error) {
    console.error('Error updating Ticket Status:', error);
    return false;
  }
}

// Helper function to update Intercom ticket Asana Status field
async function updateTicketAsanaStatus(ticketId, status) {
  try {
    console.log(`Updating ticket ${ticketId} Asana Status to: "${status}"`);

    const response = await fetch(
      `https://api.intercom.io/tickets/${ticketId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.14',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          ticket_attributes: {
            'Asana Status': status,
          },
        }),
      }
    );

    if (response.ok) {
      console.log(`✓ Successfully updated Asana Status to "${status}"`);
      return true;
    } else {
      const errorData = await response.json();
      console.error('✗ Error updating Asana Status:', errorData);
      return false;
    }
  } catch (error) {
    console.error('Error updating Asana Status:', error);
    return false;
  }
}

// Helper function to update Intercom ticket state ID based on label or category
// Optionally accepts ticket type ID for filtering states
async function updateTicketStateId(ticketId, labelOrCategory, ticketTypeId = null) {
  try {
    const stateId = await getTicketStateId(labelOrCategory, ticketTypeId);

    if (!stateId) {
      console.error(
        `✗ Could not find ticket state ID for: "${labelOrCategory}"${ticketTypeId ? ` (ticket type: ${ticketTypeId})` : ''}`
      );
      
      // Show available states from cache
      const states = await initializeTicketStates();
      if (states && states.length > 0) {
        // Filter by ticket type if provided
        const applicableStates = ticketTypeId 
          ? states.filter(state => 
              state.ticket_types?.data?.some(type => String(type.id) === String(ticketTypeId))
            )
          : states;
        
        console.error(
          `Available states${ticketTypeId ? ` for ticket type ${ticketTypeId}` : ''}:`,
          applicableStates.map((s) => s.internal_label).join(', ')
        );
      }
      return false;
    }

    console.log(
      `Updating ticket ${ticketId} ticket_state_id to: "${stateId}" (${labelOrCategory})`
    );

    const response = await fetch(
      `https://api.intercom.io/tickets/${ticketId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.14',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          ticket_state_id: stateId,
        }),
      }
    );

    if (response.ok) {
      console.log(
        `✓ Successfully updated ticket_state_id to "${stateId}" (${labelOrCategory})`
      );
      return true;
    } else {
      const errorData = await response.json();
      console.error('✗ Error updating ticket_state_id:', errorData);
      return false;
    }
  } catch (error) {
    console.error('Error updating ticket_state_id:', error);
    return false;
  }
}

// Helper function to update Intercom ticket Due Date from Asana Ticket Date
async function updateTicketDueDate(ticketId, asanaDateValue) {
  try {
    if (!asanaDateValue) {
      console.log('  ℹ No date value provided, skipping Due Date update');
      return false;
    }

    // Asana date fields return date in YYYY-MM-DD format or with date_time in ISO format
    // We need to convert to Unix timestamp for Intercom
    let dateString = null;

    // Handle Asana date_value object (date field)
    if (typeof asanaDateValue === 'object') {
      // Prefer date_time if available (includes time), otherwise use date
      dateString = asanaDateValue.date_time || asanaDateValue.date;
    } else if (typeof asanaDateValue === 'string') {
      dateString = asanaDateValue;
    }

    if (!dateString) {
      console.log('  ⚠ Could not extract date from Asana date value');
      return false;
    }

    // Convert to Unix timestamp (seconds)
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      console.error(`  ✗ Invalid date: "${dateString}"`);
      return false;
    }

    const unixTimestamp = Math.floor(date.getTime() / 1000);
    console.log(
      `  Updating ticket ${ticketId} Due Date to: "${dateString}" (Unix: ${unixTimestamp})`
    );

    const response = await fetch(
      `https://api.intercom.io/tickets/${ticketId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.14',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          ticket_attributes: {
            'Due Date': unixTimestamp,
          },
        }),
      }
    );

    if (response.ok) {
      console.log(`  ✓ Successfully updated Due Date to "${dateString}"`);
      return true;
    } else {
      const errorData = await response.json();
      console.error('  ✗ Error updating Due Date:', errorData);
      return false;
    }
  } catch (error) {
    console.error('Error updating ticket Due Date:', error);
    return false;
  }
}

// Helper function to format date for Asana date field (YYYY-MM-DD)
function formatDateForAsanaDateField(dateValue) {
  if (!dateValue) return null;

  try {
    let date;

    // Handle Unix timestamp (number or string number)
    if (typeof dateValue === 'number' || !isNaN(Number(dateValue))) {
      date = new Date(Number(dateValue) * 1000); // Convert seconds to milliseconds
    }
    // Handle ISO string or other date formats
    else if (typeof dateValue === 'string') {
      date = new Date(dateValue);
    }
    // Handle Date object
    else if (dateValue instanceof Date) {
      date = dateValue;
    } else {
      console.warn('Unknown date format:', dateValue);
      return null;
    }

    // Validate the date
    if (isNaN(date.getTime())) {
      console.warn('Invalid date value:', dateValue);
      return null;
    }

    // Format as YYYY-MM-DD for Asana date field
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  } catch (error) {
    console.error('Error formatting date for Asana:', error);
    return null;
  }
}

// Helper function to get enum option ID from custom field
async function getAsanaEnumOptionId(fieldGid, optionName) {
  try {
    const response = await fetch(
      `https://app.asana.com/api/1.0/custom_fields/${fieldGid}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      const enumOptions = data.data.enum_options || [];

      // Find the option that matches the name
      const matchingOption = enumOptions.find(
        (option) => option.name === optionName
      );

      if (matchingOption) {
        console.log(
          `Found enum option ID for "${optionName}": ${matchingOption.gid}`
        );
        return matchingOption.gid;
      } else {
        console.warn(
          `No enum option found for "${optionName}" in field ${fieldGid}`
        );
        console.warn(
          'Available options:',
          enumOptions.map((o) => o.name).join(', ')
        );
        return null;
      }
    }
    return null;
  } catch (error) {
    console.error('Error fetching enum options:', error);
    return null;
  }
}

// Helper function to get custom field settings for a project
async function getAsanaCustomFields() {
  try {
    const response = await fetch(
      `https://app.asana.com/api/1.0/projects/${ASANA_PROJECT}/custom_field_settings`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data.data;
    }
    return null;
  } catch (error) {
    console.error('Error fetching custom fields:', error);
    return null;
  }
}



// Helper function to initialize custom field mappings
// Can accept already-fetched customFieldSettings to avoid duplicate API calls
async function initializeCustomFieldMappings(customFieldSettings = null) {
  try {
    // Only fetch if not provided
    if (!customFieldSettings) {
      console.log('Fetching Asana custom field mappings...');
      customFieldSettings = await getAsanaCustomFields();
    }

    if (!customFieldSettings || customFieldSettings.length === 0) {
      console.warn('⚠ No custom fields found in Asana project');
      console.warn(
        'Custom field syncing will be disabled. Please add custom fields to your Asana project.'
      );
      return null;
    }

    const fieldTypes = {};
    
    // Track critical system fields
    let hasIntercomConversationId = false;
    let hasTicketStatus = false;

    // Map all custom fields dynamically (no hardcoded list)
    console.log(`Mapping ${customFieldSettings.length} custom fields from Asana...`);
    customFieldSettings.forEach((setting) => {
      const fieldName = setting.custom_field.name;
      const fieldGid = setting.custom_field.gid;
      const fieldType = setting.custom_field.resource_subtype;

      // Track critical fields
      if (fieldName === 'Intercom Conversation ID') {
        hasIntercomConversationId = true;
        ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID = fieldGid;
        console.log(`✓ Mapped critical field: "${fieldName}" → ${fieldGid} (type: ${fieldType})`);
      } else if (fieldName === 'Ticket Status') {
        hasTicketStatus = true;
        ASANA_CUSTOM_FIELDS.TICKET_STATUS = fieldGid;
        console.log(`✓ Mapped critical field: "${fieldName}" → ${fieldGid} (type: ${fieldType})`);
      } else {
        console.log(`✓ Mapped: "${fieldName}" → ${fieldGid} (type: ${fieldType})`);
      }

      // Store all field types for ALL fields (including system fields)
      fieldTypes[fieldGid] = fieldType;
    });

    // Store field types globally
    customFieldTypes = fieldTypes;

    // Warn about missing critical fields
    if (!hasIntercomConversationId) {
      console.warn('\n⚠⚠⚠ CRITICAL WARNING ⚠⚠⚠');
      console.warn(
        'The "Intercom Conversation ID" field is REQUIRED for webhook sync!'
      );
      console.warn(
        'Without this field, Asana webhooks cannot update Intercom tickets.'
      );
      console.warn(
        'Please create a TEXT field named "Intercom Conversation ID" in your Asana project.'
      );
      console.warn('⚠⚠⚠⚠⚠⚠⚠⚠⚠⚠⚠⚠⚠⚠⚠⚠⚠⚠⚠\n');
    }

    if (!hasTicketStatus) {
      console.warn(
        '⚠️ WARNING: "Ticket Status" field not found in Asana project'
      );
      console.warn(
        '   Please add "Ticket Status" enum field to your Asana project for status sync'
      );
    }

    if (hasIntercomConversationId && hasTicketStatus) {
      console.log('✓ All critical fields mapped successfully');
    }

    // Mark as initialized by storing the custom field settings
    customFieldsCache = customFieldSettings;
    return customFieldSettings;
  } catch (error) {
    console.error('Error initializing custom field mappings:', error);
    return null;
  }
}

// Helper function to validate if string is a valid URL
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

// Helper function to format date for Asana as text in Singapore timezone
// Format: M/D/YYYY, h:mm AM/PM
function formatDateForAsana(dateValue) {
  if (!dateValue) return null;

  try {
    let date;

    // Handle Unix timestamp (number or string number)
    if (typeof dateValue === 'number' || !isNaN(Number(dateValue))) {
      date = new Date(Number(dateValue) * 1000); // Convert seconds to milliseconds
    }
    // Handle ISO string or other date formats
    else if (typeof dateValue === 'string') {
      date = new Date(dateValue);
    }
    // Handle Date object
    else if (dateValue instanceof Date) {
      date = dateValue;
    } else {
      console.warn('Unknown date format:', dateValue);
      return null;
    }

    // Validate the date
    if (isNaN(date.getTime())) {
      console.warn('Invalid date value:', dateValue);
      return null;
    }

    // Format to Singapore timezone: M/D/YYYY, h:mm AM/PM
    const options = {
      timeZone: 'Asia/Singapore',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    };

    const formatter = new Intl.DateTimeFormat('en-US', options);
    const formattedDate = formatter.format(date);

    return formattedDate;
  } catch (error) {
    console.error('Error formatting date:', error);
    return null;
  }
}

// Helper function to extract attachment URLs from field value
function extractAttachmentUrls(fieldValue, fieldName) {
  const urls = [];

  if (!fieldValue) {
    return urls;
  }

  // Handle array of attachment objects
  if (Array.isArray(fieldValue) && fieldValue.length > 0) {
    console.log(`  Found ${fieldValue.length} file(s) in ${fieldName}`);
    for (let i = 0; i < fieldValue.length; i++) {
      const attachment = fieldValue[i];
      if (attachment && attachment.url) {
        urls.push(attachment.url);
        console.log(`  ✓ File ${i + 1}:`, attachment.url);
        if (attachment.name) console.log(`    Name: ${attachment.name}`);
        if (attachment.content_type)
          console.log(`    Type: ${attachment.content_type}`);
      } else {
        console.log(`  ⚠ File ${i + 1} missing URL property`);
      }
    }
  }
  // Handle single attachment object
  else if (typeof fieldValue === 'object' && fieldValue.url) {
    urls.push(fieldValue.url);
    console.log(`  ✓ Found single file in ${fieldName}`);
    if (fieldValue.name) console.log(`    Name: ${fieldValue.name}`);
  }
  // Handle URL string
  else if (isValidUrl(String(fieldValue))) {
    urls.push(String(fieldValue));
    console.log(`  ✓ ${fieldName} contains URL string`);
  } else {
    console.log(`  ⚠ ${fieldName} is not a valid URL or file object`);
  }

  return urls;
}

// Helper function to upload attachment to Asana task
async function uploadAttachmentToAsana(taskId, attachmentUrl) {
  try {
    // Validate if it's a proper URL
    if (!isValidUrl(attachmentUrl)) {
      console.error('Invalid attachment URL:', attachmentUrl);
      console.log(
        'The attachment field appears to be an ID or invalid URL. Please provide a full URL.'
      );
      return null;
    }

    // Download the file from the attachment URL
    console.log('===== ATTACHMENT DOWNLOAD PROCESS =====');
    console.log('Full attachment URL:', attachmentUrl);
    console.log('Attempting to download...');

    const fileResponse = await fetch(attachmentUrl);

    if (!fileResponse.ok) {
      console.error(
        'Failed to download attachment. Status:',
        fileResponse.status
      );
      console.error('Status Text:', fileResponse.statusText);
      return null;
    }

    console.log('✓ Successfully downloaded attachment');
    console.log('Content-Type:', fileResponse.headers.get('content-type'));
    console.log('Content-Length:', fileResponse.headers.get('content-length'));

    // Get the file buffer and content type
    const fileBuffer = await fileResponse.buffer();
    const contentType =
      fileResponse.headers.get('content-type') || 'application/octet-stream';

    // Extract filename from URL or use a default
    const urlParts = attachmentUrl.split('/');
    const fileName =
      urlParts[urlParts.length - 1].split('?')[0] || 'attachment';

    // Create form data for multipart upload
    const formData = new FormData();
    formData.append('parent', taskId);
    formData.append('file', fileBuffer, {
      filename: fileName,
      contentType: contentType,
    });

    // Upload to Asana
    console.log('===== ASANA UPLOAD PROCESS =====');
    console.log('Uploading to Asana task ID:', taskId);
    console.log('File name:', fileName);
    console.log('Content type:', contentType);
    console.log('File size:', fileBuffer.length, 'bytes');

    const asanaResponse = await fetch(
      'https://app.asana.com/api/1.0/attachments',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          ...formData.getHeaders(),
        },
        body: formData,
      }
    );

    if (asanaResponse.ok) {
      const asanaData = await asanaResponse.json();
      const permanentUrl =
        asanaData.data?.permanent_url ||
        asanaData.data?.download_url ||
        asanaData.data?.url ||
        'uploaded'; // Return a truthy value even if URL is missing
      console.log('✓ Successfully uploaded attachment to Asana');
      console.log('Asana response:', JSON.stringify(asanaData, null, 2));
      if (permanentUrl && permanentUrl !== 'uploaded') {
        console.log('Asana permanent URL:', permanentUrl);
      } else {
        console.log('Note: No permanent URL in response, but upload succeeded');
      }
      console.log('======================================');
      return permanentUrl;
    } else {
      const errorData = await asanaResponse
        .json()
        .catch(() => ({ error: 'Unknown error' }));
      console.error('✗ Error uploading attachment to Asana:', errorData);
      console.error(
        'Response status:',
        asanaResponse.status,
        asanaResponse.statusText
      );
      console.error('======================================');
      return null;
    }
  } catch (error) {
    console.error('Error in uploadAttachmentToAsana:', error);
    return null;
  }
}

// Root route - serves the HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Helper endpoint to get custom field GIDs and current mappings
app.get('/asana-custom-fields', async (req, res) => {
  try {
    const customFieldSettings = await getAsanaCustomFields();

    if (customFieldSettings) {
      const fields = customFieldSettings.map((setting) => ({
        name: setting.custom_field.name,
        gid: setting.custom_field.gid,
        type: setting.custom_field.resource_type,
        description: setting.custom_field.description,
      }));

      res.json({
        success: true,
        project_id: ASANA_PROJECT,
        all_custom_fields: fields,
        mapped_fields: {
          CASH_OUT_DATE_AND_TIME: ASANA_CUSTOM_FIELDS.CASH_OUT_DATE_AND_TIME,
          CASH_OUT_SLIP: ASANA_CUSTOM_FIELDS.CASH_OUT_SLIP,
          E_WALLET: ASANA_CUSTOM_FIELDS.E_WALLET,
          TRANSACTION_ID: ASANA_CUSTOM_FIELDS.TRANSACTION_ID,
          AGENT_NUMBER: ASANA_CUSTOM_FIELDS.AGENT_NUMBER,
          AMOUNT: ASANA_CUSTOM_FIELDS.AMOUNT,
          REMARK: ASANA_CUSTOM_FIELDS.REMARK,
          CASHOUT_SLIP_ASANA: ASANA_CUSTOM_FIELDS.CASHOUT_SLIP_ASANA,
          INTERCOM_CONVERSATION_ID:
            ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID,
          TICKET_STATUS: ASANA_CUSTOM_FIELDS.TICKET_STATUS,
        },
        message:
          'Custom fields are automatically mapped on server start. Check mapped_fields to see current mappings.',
      });
    } else {
      res.json({
        success: false,
        message: 'Failed to fetch custom fields from Asana',
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Helper endpoint to view webhook setup information
app.get('/webhook-info', (req, res) => {
  const webhookUrl = `${req.protocol}://${req.get('host')}/asana-webhook-prod`;
  const intercomWebhookUrl = `${req.protocol}://${req.get(
    'host'
  )}/intercom-webhook`;

  res.json({
    success: true,
    asana_webhook_url: webhookUrl,
    intercom_webhook_url: intercomWebhookUrl,
    webhook_secret_stored: asanaWebhookSecret ? true : false,
    project_gid: ASANA_PROJECT,
    custom_field_mappings: {
      CASH_OUT_DATE_AND_TIME: ASANA_CUSTOM_FIELDS.CASH_OUT_DATE_AND_TIME,
      CASH_OUT_SLIP: ASANA_CUSTOM_FIELDS.CASH_OUT_SLIP,
      E_WALLET: ASANA_CUSTOM_FIELDS.E_WALLET,
      TRANSACTION_ID: ASANA_CUSTOM_FIELDS.TRANSACTION_ID,
      AGENT_NUMBER: ASANA_CUSTOM_FIELDS.AGENT_NUMBER,
      AMOUNT: ASANA_CUSTOM_FIELDS.AMOUNT,
      REMARK: ASANA_CUSTOM_FIELDS.REMARK,
      CASHOUT_SLIP_ASANA: ASANA_CUSTOM_FIELDS.CASHOUT_SLIP_ASANA,
      INTERCOM_CONVERSATION_ID: ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID,
      TICKET_STATUS: ASANA_CUSTOM_FIELDS.TICKET_STATUS,
    },
    setup_instructions: {
      asana: {
        step1:
          'Make sure this server is publicly accessible (use ngrok for local development)',
        step2: `Create webhook using: POST https://app.asana.com/api/1.0/webhooks`,
        step3: 'Set resource to your project GID',
        step4: `Set target to: ${webhookUrl}`,
        step5: 'The handshake will be completed automatically',
      },
      intercom: {
        step1: 'Go to Intercom Developer Hub → Webhooks',
        step2: `Add webhook URL: ${intercomWebhookUrl}`,
        step3: 'Subscribe to topic: ticket.note.created',
        step4: 'Save the webhook configuration',
        note: 'This will sync admin notes from Intercom to Asana as comments',
      },
    },
    curl_example: `curl -X POST https://app.asana.com/api/1.0/webhooks \\
  -H "Authorization: Bearer ${ASANA_TOKEN}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "data": {
      "resource": "${ASANA_PROJECT}",
      "target": "${webhookUrl}"
    }
  }'`,
    task_to_conversation_mappings: asanaTaskToConversation.size,
  });
});

/*
  Intercom webhook endpoint to receive conversation note events
  When an admin adds a note to a conversation, sync it to the linked Asana task
*/
app.post('/intercom-webhook', async (req, res) => {
  console.log('\n===== INTERCOM WEBHOOK EVENT =====');
  console.log('Received webhook event at:', new Date().toISOString());
  console.log('Request body:', JSON.stringify(req.body, null, 2));

  try {
    const topic = req.body.topic;
    const data = req.body.data?.item;

    console.log('Event topic:', topic);

    // Handle ticket.note.created event
    if (topic === 'ticket.note.created') {
      console.log('  Processing ticket note created event');

      const ticket = data?.ticket;
      const ticketPart = data?.ticket_part;

      if (!ticket || !ticketPart) {
        console.log('  ⚠ Missing ticket or ticket_part in webhook data');
        return res.status(200).send();
      }

      // Get Asana task ID directly from ticket attributes
      const asanaTaskId = ticket?.ticket_attributes?.['Asana Task ID'];

      if (!asanaTaskId) {
        console.log('  ⚠ No Asana task ID found for this ticket');
        console.log('  Ticket attributes:', Object.keys(ticket?.ticket_attributes || {}).join(', '));
        console.log('  Skipping note sync - ticket not linked to Asana');
        return res.status(200).send();
      }

      console.log('  Ticket ID:', ticket.id);
      console.log('  Asana Task ID:', asanaTaskId);

      // Get note details from ticket_part
      const noteBody = ticketPart.body;
      const noteAuthor = ticketPart.author?.name || 'Admin';
      const appPackageCode = ticketPart.app_package_code;

      if (!noteBody) {
        console.log('  ⚠ No note body found');
        return res.status(200).send();
      }

      // Check if note was created by an integration app (to prevent loop)
      if (appPackageCode) {
        console.log(
          `  ℹ Skipping - note was created by app package: ${appPackageCode} (preventing loop)`
        );
        return res.status(200).send();
      }

      console.log('  Note author:', noteAuthor);
      console.log('  Note body:', noteBody);

      // Strip HTML tags from note body (simple regex - could be improved)
      const plainTextBody = noteBody
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim();

      // Check if this note was created by the integration (to prevent loop)
      if (plainTextBody.startsWith('[Asana Comment by')) {
        console.log(
          '  ℹ Skipping - note was synced from Asana (preventing loop)'
        );
        return res.status(200).send();
      }

      // Format note for Asana comment
      const commentBody = `[Intercom Note by ${noteAuthor}]\n${plainTextBody}`;

      // Post comment to Asana task
      const asanaResponse = await fetch(
        `https://app.asana.com/api/1.0/tasks/${asanaTaskId}/stories`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ASANA_TOKEN}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            data: {
              text: commentBody,
            },
          }),
        }
      );

      if (asanaResponse.ok) {
        const asanaData = await asanaResponse.json();
        console.log('  ✓ Note posted to Asana task as comment');
        console.log('  Asana story ID:', asanaData.data.gid);
      } else {
        const errorData = await asanaResponse.json();
        console.error('  ✗ Failed to post note to Asana:', errorData);
      }
    }
    // Handle conversation.admin.noted event (legacy support)
    else if (topic === 'conversation.admin.noted') {
      console.log('  Processing admin note event');

      const conversationId = data?.id;
      if (!conversationId) {
        console.log('  ⚠ No conversation ID in webhook data');
        return res.status(200).send();
      }

      console.log('  Conversation ID:', conversationId);

      // Get the full conversation details to access the note
      const conversation = await getConversation(conversationId);
      if (!conversation) {
        console.log('  ⚠ Could not fetch conversation details');
        return res.status(200).send();
      }

      // Get ticket ID from conversation
      const ticketId = conversation?.ticket?.id;
      if (!ticketId) {
        console.log('  ⚠ No ticket found for this conversation');
        return res.status(200).send();
      }

      console.log('  Ticket ID:', ticketId);

      // Get ticket details to find Asana task ID
      const ticket = await getTicket(ticketId);
      const asanaTaskId = ticket?.ticket_attributes?.['Asana Task ID'];

      if (!asanaTaskId) {
        console.log('  ⚠ No Asana task ID found for this ticket');
        console.log('  Ticket attributes:', Object.keys(ticket?.ticket_attributes || {}).join(', '));
        console.log('  Skipping note sync - ticket not linked to Asana');
        return res.status(200).send();
      }

      console.log('  Asana Task ID:', asanaTaskId);

      // Get the latest note from conversation parts
      const conversationParts =
        conversation?.conversation_parts?.conversation_parts || [];

      // Find the most recent admin note
      let latestNote = null;
      for (let i = conversationParts.length - 1; i >= 0; i--) {
        const part = conversationParts[i];
        if (part.part_type === 'note' && part.body) {
          latestNote = part;
          break;
        }
      }

      if (!latestNote) {
        console.log('  ⚠ No note found in conversation parts');
        return res.status(200).send();
      }

      // Check if note was created by an integration app (to prevent loop)
      if (latestNote.app_package_code) {
        console.log(
          `  ℹ Skipping - note was created by app package: ${latestNote.app_package_code} (preventing loop)`
        );
        return res.status(200).send();
      }

      console.log('  Note author:', latestNote.author?.name || 'Unknown');
      console.log('  Note body:', latestNote.body);

      // Strip HTML tags
      const plainTextBody = latestNote.body
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim();

      // Check if this note was created by the integration (to prevent loop)
      if (plainTextBody.startsWith('[Asana Comment by')) {
        console.log(
          '  ℹ Skipping - note was synced from Asana (preventing loop)'
        );
        return res.status(200).send();
      }

      // Format note for Asana comment
      const commentBody = `[Intercom Note by ${
        latestNote.author?.name || 'Admin'
      }]\n${plainTextBody}`;

      // Post comment to Asana task
      const asanaResponse = await fetch(
        `https://app.asana.com/api/1.0/tasks/${asanaTaskId}/stories`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ASANA_TOKEN}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            data: {
              text: commentBody,
            },
          }),
        }
      );

      if (asanaResponse.ok) {
        const asanaData = await asanaResponse.json();
        console.log('  ✓ Note posted to Asana task as comment');
        console.log('  Asana story ID:', asanaData.data.gid);
      } else {
        const errorData = await asanaResponse.json();
        console.error('  ✗ Failed to post note to Asana:', errorData);
      }
    } else {
      console.log('  ℹ Ignoring event topic:', topic);
    }

    console.log('==================================\n');
    res.status(200).send();
  } catch (error) {
    console.error('Error processing Intercom webhook:', error);
    res.status(500).send();
  }
});

/*
  This is an endpoint that Intercom will POST HTTP request when a teammate inserts 
  the app into the inbox, or a new conversation is viewed.
*/
app.post('/initialize', async (req, res) => {
  console.log('Initialize endpoint hit');
  console.log('Initialize request body:', JSON.stringify(req.body, null, 2));

  const conversationId = req.body.conversation?.id;

  // Check if this conversation already has an Asana task
  if (conversationId) {
    const conversation = await getConversation(conversationId);
    const ticketId = conversation?.ticket?.id;

    if (ticketId) {
      const ticket = await getTicket(ticketId);
      const asanaTaskId = ticket?.ticket_attributes?.['Asana Task ID'];

      if (asanaTaskId) {
        // Ticket already has an Asana task
        console.log('Existing Asana task found:', asanaTaskId);
        const components = [
          {
            type: 'text',
            id: 'success',
            text: '✓ Asana Task Already Created',
            align: 'center',
            style: 'header',
          },
          {
            type: 'text',
            id: 'task_id',
            text: `Task ID: ${asanaTaskId}`,
            align: 'center',
            style: 'paragraph',
          },
        ];

        const completedCanvas = {
          canvas: {
            content: {
              components: components,
            },
          },
        };
        return res.send(completedCanvas);
      }
    }
  }

  // No existing task, show create button
  res.send(initialCanvas);
});

/*
  When a submit action is taken in a canvas component, it will hit this endpoint.
  This endpoint creates an Asana task with the contact's name and prevents
  duplicate submissions per conversation.
*/
app.post('/submit', async (req, res) => {
  console.log('\n===== SUBMIT ENDPOINT CALLED =====');
  console.log('Component ID:', req.body.component_id);
  console.log('Full request body:', JSON.stringify(req.body, null, 2));

  const conversationId = req.body.conversation?.id;
  const ticketId = req.body.conversation?.ticket?.id;
  
  console.log('Extracted conversation ID:', conversationId);
  console.log('Extracted ticket ID:', ticketId);
  console.log('==================================\n');

  // Check if this conversation already has an Asana task (only for submit_button)
  if (req.body.component_id === 'submit_button') {
    try {
      // Get ticket ID from request body
      console.log('=== SUBMIT ROUTE DEBUG ===');
      console.log('Conversation ID:', conversationId);
      console.log('Ticket ID:', ticketId);
      
      if (!ticketId) {
        console.error('❌ No ticket ID found in request body');
        throw new Error('No ticket found for this conversation');
      }

      // Fetch all required data in parallel for optimal performance
      console.log('📡 Fetching all required data in parallel...');
      
      const contactId = req.body.contact?.id || req.body.customer?.id;
      const contactNameFromBody = req.body.contact?.name || req.body.customer?.name;
      
      console.log('Contact ID:', contactId);
      console.log('Contact Name from body:', contactNameFromBody);

      const [ticket, asanaCustomFieldSettings, contactNameFromApi] = await Promise.all([
        getTicket(ticketId),
        getAsanaCustomFields(),
        // Only fetch contact name if not in request body and we have a contact ID
        !contactNameFromBody && contactId ? getContactName(contactId) : Promise.resolve(null),
      ]);
      
      console.log('✓ Promise.all completed');
      console.log('Ticket result:', ticket ? 'Fetched successfully' : '❌ NULL/UNDEFINED');
      console.log('Asana fields result:', asanaCustomFieldSettings ? `${asanaCustomFieldSettings.length} fields` : '❌ NULL/UNDEFINED');
      console.log('Contact name result:', contactNameFromApi || 'Not fetched');

      // Ensure custom fields are initialized (pass already-fetched settings to avoid refetch)
      if (!customFieldsCache) {
        console.log('Custom fields not initialized, initializing now...');
        await initializeCustomFieldMappings(asanaCustomFieldSettings);
      }

      // Determine contact name
      const contactName = contactNameFromBody || contactNameFromApi || 'Unknown Contact';

      // Validate ticket was fetched successfully
      if (!ticket) {
        console.error('❌ TICKET FETCH FAILED');
        console.error('Ticket ID used:', ticketId);
        console.error('Ticket result:', ticket);
        throw new Error('Failed to fetch ticket details');
      }
      
      console.log('✓ Ticket validation passed');
      console.log('Ticket ID:', ticket.id || 'N/A');
      console.log('Ticket has attributes:', !!ticket.ticket_attributes);
      console.log('Ticket has state:', !!ticket.ticket_state);

      // Check if Asana task already exists for this ticket
      const existingTaskId = ticket.ticket_attributes?.['Asana Task ID'];
      if (existingTaskId) {
        // Task already exists, return early
        const components = [
          {
            type: 'text',
            id: 'already_submitted',
            text: '✓ Task Already Exists',
            align: 'center',
            style: 'header',
          },
          {
            type: 'text',
            id: 'task_id',
            text: `Task ID: ${existingTaskId}`,
            align: 'center',
            style: 'paragraph',
          },
        ];

        const alreadySubmittedCanvas = {
          canvas: {
            content: {
              components: components,
            },
          },
        };
        return res.send(alreadySubmittedCanvas);
      }

      const ticketAttrs = ticket?.ticket_attributes || {};

      // Get the actual Intercom ticket state (not from custom attributes)
      // Intercom ticket has ticket_state object with name, category, internal_label, etc.
      const ticketStatus = ticket?.ticket_state?.name || 
                          ticket?.ticket_state?.internal_label || 
                          ticket?.state || 
                          'Submitted';

      console.log('Ticket Status from Intercom ticket_state:', ticketStatus);
      console.log('\n===== DYNAMIC FIELD SYNC FROM INTERCOM TO ASANA =====');

      if (!asanaCustomFieldSettings || asanaCustomFieldSettings.length === 0) {
        console.warn('⚠ No custom fields found in Asana project');
      }

      // Handle file upload fields for attachments
      let attachmentUrls = [];
      
      console.log('\n===== FILE UPLOAD PROCESSING FROM TICKET =====');

      // Build basic task notes
      const taskNotes = `Task created from Intercom conversation ${conversationId}

Contact Information:
- Name: ${contactName}
- Email: ${req.body.contact?.email || req.body.customer?.email || 'N/A'}`;

      // Build custom fields object for Asana dynamically
      const customFields = {};

      // Process each Asana custom field
      if (asanaCustomFieldSettings && asanaCustomFieldSettings.length > 0) {
        console.log(`Processing ${asanaCustomFieldSettings.length} custom fields from Asana...`);
        console.log('Available Intercom ticket attributes:', Object.keys(ticketAttrs).join(', '));

        for (const setting of asanaCustomFieldSettings) {
          const fieldName = setting.custom_field.name;
          const fieldGid = setting.custom_field.gid;
          const fieldType = setting.custom_field.resource_subtype;

          // Skip Ticket Status field - it's reserved for Intercom ticket status management
          if (fieldName === 'Ticket Status') {
            console.log(`  ⊘ Skipping "${fieldName}" - reserved for ticket status management`);
            continue;
          }

          // Skip Intercom Conversation ID - it's system field
          if (fieldName === 'Intercom Conversation ID') {
            console.log(`  ⊘ Skipping "${fieldName}" - system field (will be added separately)`);
            continue;
          }

          // Check if this field exists in Intercom ticket attributes
          const intercomValue = ticketAttrs[fieldName];

          // Skip empty arrays (file fields with no files)
          if (Array.isArray(intercomValue) && intercomValue.length === 0) {
            console.log(`  ○ "${fieldName}" is empty array, skipping`);
            continue;
          }

          if (intercomValue !== undefined && intercomValue !== null && intercomValue !== '') {
            console.log(`  ✓ Found "${fieldName}" in Intercom with value:`, 
              typeof intercomValue === 'object' ? JSON.stringify(intercomValue).substring(0, 100) + '...' : intercomValue);

            // First, check if Intercom value is a file/attachment (priority check)
            if (Array.isArray(intercomValue) && intercomValue.length > 0 && intercomValue[0]?.url) {
              // This is a file upload field (array of files)
              console.log(`    → Detected file upload field with ${intercomValue.length} file(s)`);
              const fileUrls = extractAttachmentUrls(intercomValue, fieldName);
              console.log(`    → Extracted ${fileUrls.length} URL(s):`, fileUrls);
              attachmentUrls.push(...fileUrls);
            } else if (typeof intercomValue === 'object' && intercomValue.url) {
              // Single file object
              console.log(`    → Detected single file upload`);
              const fileUrls = extractAttachmentUrls(intercomValue, fieldName);
              console.log(`    → Extracted ${fileUrls.length} URL(s):`, fileUrls);
              attachmentUrls.push(...fileUrls);
            }
            // If Asana field is enum, we must look up the option ID
            else if (fieldType === 'enum') {
              const enumOptionId = await getAsanaEnumOptionId(fieldGid, String(intercomValue));
              if (enumOptionId) {
                customFields[fieldGid] = enumOptionId;
                console.log(`    → Syncing as enum: ${intercomValue} (ID: ${enumOptionId})`);
              } else {
                console.log(`    ⚠ Could not find enum option "${intercomValue}" in Asana field, skipping`);
              }
            }
            // If Asana field is date type, format as YYYY-MM-DD
            else if (fieldType === 'date') {
              const formattedDateField = formatDateForAsanaDateField(intercomValue);
              if (formattedDateField) {
                customFields[fieldGid] = formattedDateField;
                console.log(`    → Syncing as date field: ${formattedDateField}`);
              } else {
                console.log(`    ⚠ Could not format date "${intercomValue}", skipping`);
              }
            }
            // For all other cases (text, number, etc.), handle based on field name pattern or as text
            else {
              // Check if it's a date/time field by name pattern (for text fields in Asana)
              if ((fieldName.toLowerCase().includes('date') || fieldName.toLowerCase().includes('time')) 
                  && typeof intercomValue !== 'object') {
                const formattedDate = formatDateForAsana(intercomValue);
                if (formattedDate) {
                  customFields[fieldGid] = formattedDate;
                  console.log(`    → Syncing as formatted date text: ${formattedDate}`);
                } else {
                  // Fallback to string value
                  customFields[fieldGid] = String(intercomValue);
                  console.log(`    → Syncing as text: ${String(intercomValue)}`);
                }
              } else {
                // Default: sync as text/string (works for text and number fields in Asana)
                customFields[fieldGid] = String(intercomValue);
                console.log(`    → Syncing as text: ${String(intercomValue)}`);
              }
            }
          } else {
            console.log(`  ○ "${fieldName}" not found or empty in Intercom ticket attributes`);
          }
        }
      }

      if (attachmentUrls.length > 0) {
        console.log(
          `\nFinal attachment URLs to upload (${attachmentUrls.length}):`,
          attachmentUrls
        );
      } else {
        console.log('\nNo file uploads to process for this task');
      }
      console.log('==================================================\n');

      // Add Ticket Status for webhook sync (enum field requires option ID)
      // Always populate Ticket Status - defaults to "Submitted" if not in Intercom
      if (ASANA_CUSTOM_FIELDS.TICKET_STATUS && ticketStatus) {
        console.log(
          'Looking up enum option ID for Ticket Status:',
          ticketStatus,
          ticketStatus === 'Submitted' ? '(default)' : '(from Intercom)'
        );
        const enumOptionId = await getAsanaEnumOptionId(
          ASANA_CUSTOM_FIELDS.TICKET_STATUS,
          ticketStatus
        );
        if (enumOptionId) {
          customFields[ASANA_CUSTOM_FIELDS.TICKET_STATUS] = enumOptionId;
          console.log(
            '✓ Adding Ticket Status to Asana custom field:',
            ticketStatus
          );
        } else {
          console.warn('Could not find enum option ID for:', ticketStatus);
          console.warn(
            'Make sure "' +
              ticketStatus +
              '" exists as an option in the Ticket Status field in Asana'
          );
        }
      } else if (!ASANA_CUSTOM_FIELDS.TICKET_STATUS) {
        console.warn(
          '⚠️ WARNING: Ticket Status custom field is not configured in Asana'
        );
        console.warn(
          '   Please add "Ticket Status" enum field to your Asana project for status sync'
        );
      }

      // Add Intercom conversation ID for webhook sync
      if (ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID && conversationId) {
        customFields[ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID] =
          String(conversationId);
        console.log(
          '✓ Adding conversation ID to Asana custom field:',
          conversationId
        );
      } else if (!ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID) {
        console.warn(
          '⚠ WARNING: "Intercom Conversation ID" custom field NOT configured!'
        );
        console.warn(
          '   Webhook sync will not work without this field. Please add it to your Asana project.'
        );
      }

      console.log('Custom fields to sync:', Object.keys(customFields).length);
      if (Object.keys(customFields).length > 0) {
        console.log(
          'Custom field values:',
          JSON.stringify(customFields, null, 2)
        );
      }

      // Create task payload
      const taskPayload = {
        workspace: ASANA_WORKSPACE,
        projects: [ASANA_PROJECT],
        name: contactName,
        notes: taskNotes,
      };

      // Only add custom_fields if we have any configured
      if (Object.keys(customFields).length > 0) {
        taskPayload.custom_fields = customFields;
      }

      console.log(
        'Creating Asana task with payload:',
        JSON.stringify(taskPayload, null, 2)
      );

      // Create Asana task
      const asanaResponse = await fetch('https://app.asana.com/api/1.0/tasks', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: taskPayload,
        }),
      });

      const asanaData = await asanaResponse.json();

      // Log detailed error if task creation failed
      if (!asanaResponse.ok) {
        console.error('Asana API Error Response:');
        console.error('Status:', asanaResponse.status);
        console.error('Response:', JSON.stringify(asanaData, null, 2));

        // Check if it's a date field error
        if (
          asanaData.errors &&
          asanaData.errors[0]?.message?.includes('date')
        ) {
          console.error('⚠️ Date field error detected!');
          console.error(
            'This usually means the "Ticket Due Date" field in Asana is not configured as a "date" type.'
          );
          console.error(
            'Please check the field type in your Asana project settings.'
          );
        }
      }

      if (asanaResponse.ok) {
        const asanaTaskId = asanaData.data.gid;

        // Upload all attachments to Asana if available
        let attachmentResults = [];
        if (attachmentUrls.length > 0) {
          console.log('\n===== ATTACHMENT PROCESSING =====');
          console.log(`Processing ${attachmentUrls.length} attachment(s)`);

          for (let i = 0; i < attachmentUrls.length; i++) {
            const attachmentUrl = attachmentUrls[i];
            console.log(
              `\n--- Processing attachment ${i + 1}/${
                attachmentUrls.length
              } ---`
            );
            console.log('Attachment URL:', attachmentUrl);

            // Check if it's a valid URL before attempting upload
            if (!isValidUrl(attachmentUrl)) {
              console.log('⚠ Attachment is not a valid URL, skipping upload');
              attachmentResults.push({
                index: i + 1,
                url: attachmentUrl,
                status: 'invalid_url',
                error: 'Invalid URL format',
              });
              continue;
            }

            console.log('✓ Valid URL detected, proceeding with upload');
            try {
              const attachmentPermanentUrl = await uploadAttachmentToAsana(
                asanaTaskId,
                attachmentUrl
              );

              if (
                attachmentPermanentUrl &&
                attachmentPermanentUrl.trim() !== ''
              ) {
                console.log(
                  '✓ Attachment uploaded successfully. Permanent URL:',
                  attachmentPermanentUrl
                );
                attachmentResults.push({
                  index: i + 1,
                  url: attachmentUrl,
                  status: 'success',
                  permanentUrl: attachmentPermanentUrl,
                });
              } else {
                console.log(
                  '✗ Attachment upload failed - no permanent URL returned'
                );
                attachmentResults.push({
                  index: i + 1,
                  url: attachmentUrl,
                  status: 'failed',
                  error: 'Upload failed - no URL returned',
                });
              }
            } catch (uploadError) {
              console.error('✗ Error during attachment upload:', uploadError);
              attachmentResults.push({
                index: i + 1,
                url: attachmentUrl,
                status: 'failed',
                error: uploadError.message || 'Upload error',
              });
            }
          }
          console.log('\n==================================');
          console.log(
            `Attachment processing complete: ${
              attachmentResults.filter((r) => r.status === 'success').length
            }/${attachmentUrls.length} successful`
          );
        } else {
          console.log('No attachments to process for this task');
        }

        // Save Asana task ID to Intercom ticket
        await updateTicketAttribute(ticketId, asanaTaskId);

        // Store mapping for webhook callbacks
        asanaTaskToConversation.set(asanaTaskId, conversationId);
        console.log(
          `Stored mapping: Asana task ${asanaTaskId} → Intercom conversation ${conversationId}`
        );

        const components = [
          {
            type: 'text',
            id: 'success',
            text: '✅ Asana Task Created',
            align: 'center',
            style: 'header',
          },
          {
            type: 'text',
            id: 'task_name',
            text: `📋 ${contactName}`,
            align: 'center',
            style: 'paragraph',
          },
          {
            type: 'text',
            id: 'task_id',
            text: `ID: ${asanaTaskId}`,
            align: 'center',
            style: 'muted',
          },
          {
            type: 'divider',
            id: 'divider_1',
          },
        ];

        // Add attachment status if attachments were processed
        if (attachmentResults.length > 0) {
          const successCount = attachmentResults.filter(
            (r) => r.status === 'success'
          ).length;
          const totalCount = attachmentResults.length;
          let statusText = '';
          let statusIcon = '';

          // Only show message if there were actual attempts
          if (totalCount > 0) {
            if (successCount === totalCount) {
              statusIcon = '📎';
              statusText = `${successCount} attachment(s) uploaded`;
            } else if (successCount > 0) {
              statusIcon = '⚠️';
              statusText = `${successCount}/${totalCount} attachment(s) uploaded`;
            } else {
              // Only show failure message if we actually tried to upload
              const attemptedCount = attachmentResults.filter(
                (r) => r.status !== 'invalid_url'
              ).length;
              if (attemptedCount > 0) {
                statusIcon = '❌';
                statusText = `Failed to upload ${totalCount} attachment(s)`;
              } else {
                statusIcon = '⚠️';
                statusText = `${totalCount} attachment(s) skipped`;
              }
            }

            components.push({
              type: 'text',
              id: 'attachment_status',
              text: `${statusIcon} ${statusText}`,
              align: 'center',
              style: 'muted',
            });
          }
        }

        const syncedFieldsText =
          Object.keys(customFields).length > 0
            ? `✓ Synced ${Object.keys(customFields).length} custom fields`
            : '⚠️ No custom fields synced';

        components.push({
          type: 'text',
          id: 'synced_fields',
          text: syncedFieldsText,
          align: 'center',
          style: 'muted',
        });

        const successCanvas = {
          canvas: {
            content: {
              components: components,
            },
          },
        };
        res.send(successCanvas);
      } else {
        throw new Error(
          asanaData.errors?.[0]?.message || 'Failed to create Asana task'
        );
      }
    } catch (error) {
      console.error('Error creating Asana task:', error);

      const errorCanvas = {
        canvas: {
          content: {
            components: [
              {
                type: 'text',
                id: 'error',
                text: '❌ Error Creating Task',
                align: 'center',
                style: 'header',
              },
              {
                type: 'divider',
                id: 'divider_1',
              },
              {
                type: 'text',
                id: 'error_message',
                text: error.message || 'An unexpected error occurred',
                align: 'center',
                style: 'paragraph',
              },
              {
                type: 'text',
                id: 'error_hint',
                text: 'Please try again or contact support',
                align: 'center',
                style: 'muted',
              },
            ],
          },
        },
      };
      res.send(errorCanvas);
    }
  } else {
    res.send(initialCanvas);
  }
});

/*
  Asana webhook endpoint to receive task completion updates
  Handles the handshake and task status change events
*/
app.post('/asana-webhook-prod', async (req, res) => {
  const hookSecret = req.headers['x-hook-secret'];

  // Handle webhook handshake
  if (hookSecret) {
    console.log('===== ASANA WEBHOOK HANDSHAKE =====');
    console.log('Received webhook handshake with secret:', hookSecret);

    // Store the secret for future verification
    asanaWebhookSecret = hookSecret;

    // Respond with the secret to complete handshake
    res.set('X-Hook-Secret', hookSecret);
    res.status(200).send();

    console.log('✓ Webhook handshake completed');
    console.log('===================================\n');
    return;
  }

  // Handle webhook events
  console.log('\n===== ASANA WEBHOOK EVENT =====');
  console.log('Received webhook event at:', new Date().toISOString());
  console.log('Request headers:', JSON.stringify(req.headers, null, 2));
  console.log('Request body:', JSON.stringify(req.body, null, 2));

  try {
    const events = req.body.events || [];
    console.log(`Processing ${events.length} event(s)`);

    for (const event of events) {
      console.log('\nEvent details:');
      console.log('  Action:', event.action);
      console.log('  Resource type:', event.resource?.resource_type);
      console.log('  Resource GID:', event.resource?.gid);

      // Process story (comment) events
      if (
        event.resource?.resource_type === 'story' &&
        event.action === 'added' &&
        event.parent?.resource_type === 'task'
      ) {
        const storyId = event.resource.gid;
        const taskId = event.parent.gid;
        console.log('  New story added to task:', taskId);

        // Fetch the story details to get the comment text
        const storyResponse = await fetch(
          `https://app.asana.com/api/1.0/stories/${storyId}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${ASANA_TOKEN}`,
              Accept: 'application/json',
            },
          }
        );

        if (storyResponse.ok) {
          const storyData = await storyResponse.json();
          const story = storyData.data;

          // Only process actual comments, not system events
          if (story.resource_subtype === 'comment_added' && story.text) {
            console.log('  Comment text:', story.text);
            console.log('  Created by:', story.created_by?.name);

            // Check if this comment was created by the integration (to prevent loop)
            if (story.text.startsWith('[Intercom Note by')) {
              console.log(
                '  ℹ Skipping - comment was synced from Intercom (preventing loop)'
              );
              continue;
            }

            // Get conversation ID from task (using shared helper)
            const result = await getConversationIdFromTask(taskId);

            if (result && result.conversationId) {
              const conversationId = result.conversationId;
              console.log('  Found conversation ID:', conversationId);

              // Post comment to Intercom conversation as a private note
              const commentBody = `[Asana Comment by ${
                story.created_by?.name || 'Unknown'
              }]\n${story.text}`;

              const intercomResponse = await fetch(
                `https://api.intercom.io/conversations/${conversationId}/reply`,
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${INTERCOM_TOKEN}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                  },
                  body: JSON.stringify({
                    message_type: 'note',
                    type: 'admin',
                    admin_id: INTERCOM_ADMIN_ID,
                    body: commentBody,
                  }),
                }
              );

              if (intercomResponse.ok) {
                console.log(
                  '  ✓ Comment posted to Intercom conversation as private note'
                );
              } else {
                const errorData = await intercomResponse.json();
                console.error(
                  '  ✗ Failed to post comment to Intercom:',
                  errorData
                );
              }
            } else {
              console.log(
                '  ⚠ Skipping comment sync - no conversation ID found'
              );
            }
          }
        }
      }

      // Only process task field changes
      if (
        event.resource?.resource_type === 'task' &&
        event.action === 'changed'
      ) {
        const taskId = event.resource.gid;
        console.log('  Task changed event for task:', taskId);
        console.log(
          '  Event change details:',
          JSON.stringify(event.change, null, 2)
        );

        // Check if this is a custom field change
        let isTicketStatusChange = false;
        if (event.change && event.change.field === 'custom_fields') {
          console.log('  ✓ Custom field change detected');
          // Log the new value if available
          if (event.change.new_value) {
            console.log(
              '  New value:',
              JSON.stringify(event.change.new_value, null, 2)
            );
          }
          isTicketStatusChange = true;
        }

        // Get conversation ID from task (using shared helper)
        const result = await getConversationIdFromTask(taskId);

        if (!result || !result.conversationId) {
          console.log('  Skipping webhook update');
          continue;
        }

        const conversationId = result.conversationId;
        const taskData = result.taskData;
        const customFields = taskData.custom_fields || [];

        // Extract Ticket Status from custom fields
        let ticketStatus = null;

        for (const field of customFields) {
          // Match Ticket Status by GID or name
          if (
            field.gid === ASANA_CUSTOM_FIELDS.TICKET_STATUS ||
            field.name === 'Ticket Status'
          ) {
            console.log(
              '  Ticket Status field found:',
              JSON.stringify(field, null, 2)
            );

            // For enum fields, get the value properly
            if (field.enum_value) {
              ticketStatus = field.enum_value.name;
              console.log(
                '  Ticket Status from enum_value.name:',
                ticketStatus
              );
            } else if (field.display_value) {
              ticketStatus = field.display_value;
              console.log('  Ticket Status from display_value:', ticketStatus);
            }

            if (ticketStatus) {
              console.log(
                '  ✓ Found Ticket Status in custom field:',
                ticketStatus
              );
            } else {
              console.log('  ⚠ Ticket Status field exists but has no value');
            }
            break;
          }
        }

        // Log all custom field GIDs for debugging
        console.log('\n  === DEBUGGING CUSTOM FIELDS ===');
        console.log(
          '  Expected Intercom Conversation ID field GID:',
          ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID || '(NOT CONFIGURED)'
        );
        console.log(
          '  Expected Ticket Status field GID:',
          ASANA_CUSTOM_FIELDS.TICKET_STATUS || '(NOT CONFIGURED)'
        );
        console.log(
          '  Expected Ticket Date field GID:',
          ASANA_CUSTOM_FIELDS.TICKET_DATE || '(NOT CONFIGURED)'
        );

        if (customFields.length > 0) {
          console.log('  All custom field GIDs on task:');
          customFields.forEach((f) => {
            let value =
              f.enum_value?.name ||
              f.display_value ||
              f.text_value ||
              f.number_value ||
              '(no value)';
            // Handle date fields
            if (f.date_value) {
              value =
                f.date_value.date || f.date_value.date_time || '(no date)';
            }
            console.log(`    - ${f.name} (${f.gid}): ${value}`);
          });
        } else {
          console.log('  ⚠ WARNING: No custom fields found on this task!');
        }
        console.log('  ===============================\n');

        // Get conversation to find ticket ID
        const conversation = await getConversation(conversationId);
        const ticketId = conversation?.ticket?.id;

        if (!ticketId) {
          console.log('  ⚠ No ticket found for conversation:', conversationId);
          console.log('  Skipping webhook update');
          continue;
        }

        // Fetch full ticket to get ticket type ID
        const ticket = await getTicket(ticketId);
        const ticketTypeId = ticket?.ticket_type?.id;
        
        if (ticketTypeId) {
          console.log(`  ℹ Ticket type ID: ${ticketTypeId}`);
        }

        // Update Intercom ticket's Ticket Status if it changed
        if (ticketStatus) {
          const stateUpdateResult = await updateTicketStateId(
            ticketId,
            ticketStatus,
            ticketTypeId // Pass ticket type ID for filtering
          );
          if (stateUpdateResult) {
            console.log('  ✓ Successfully updated Intercom ticket state ID');
          } else {
            console.log(
              "  ℹ Could not match ticket status to a state ID (this is normal if status doesn't match state labels)"
            );
          }
        } else {
          console.log('  ℹ No Ticket Status value to sync');
          console.log(
            '  Expected custom field GID:',
            ASANA_CUSTOM_FIELDS.TICKET_STATUS
          );
        }
      }
    }

    console.log('================================\n');
    res.status(200).send();
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send();
  }
});

const listener = app.listen(PORT, async () => {
  console.log(`Your app is listening on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to view your app`);
  console.log('\n========================================');

  // Initialize custom field mappings from Asana
  await initializeCustomFieldMappings();

  // Initialize ticket states from Intercom
  await initializeTicketStates();

  console.log('========================================\n');
  console.log('✓ Server is ready to accept requests');
});
