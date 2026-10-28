{% test free_range(model, column_name, min, max) %}
select * from {{ model }} where {{ column_name }} < {{ min }} or {{ column_name }} > {{ max }}
{% endtest %}
